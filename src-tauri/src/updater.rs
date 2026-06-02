// updater — In-app güncelleme: kaynak dosyaları binary mtime ile karşılaştır;
// "orchestrator" (TS-only hızlı yol: subprocess restart — SADECE dev mode) veya
// "full" (Tauri release build + .app swap + relaunch) modunda update tetikle.
// Paketli app orchestrator'ı .app içindeki bundled dist'ten çalıştırdığı için
// orchestrator değişikliği de "full" gerektirir (bkz. check_update_status):
// repo dist'ini rebuild edip subprocess restart etmek eski bundled kodu yükler.
//
// Embedded helper bash script: full mode için detached spawn. SOURCE_ROOT
// compile-time `env!("CARGO_MANIFEST_DIR")` üzerinden türer; helper script'e
// 3. argüman olarak geçirilir. Hardcoded user-specific path yok.
//
// Mimari yasak yok — Claude CLI yok; sadece npm + bash + open.

// Source yolları compile-time'da `env!("CARGO_MANIFEST_DIR")`'den türetilir.
// CARGO_MANIFEST_DIR = src-tauri/ (Cargo.toml'un bulunduğu dizin); parent =
// proje kökü. Kullanıcı projeyi farklı bir konuma taşırsa yeni build doğru
// yolları yakalar — hardcoded path yok.
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, State};

use crate::orchestrator::{start_session, stop_session, OrchestratorState, Session};

const SOURCE_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");
const ORCHESTRATOR_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../orchestrator");
const ORCHESTRATOR_SRC: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../orchestrator/src");
const APP_SRC: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src");
const TAURI_SRC: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src");
const TEMPLATES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../assets/templates");

const HELPER_SCRIPT: &str = include_str!("update_helper.sh");

/// Re-entrant guard — update sırasında ikinci tıklamayı reddet. UPDATING
/// AtomicBool tek update'i serialize ettiği için helper script tmpdir yazımı
/// için ek kilit gerekmez.
static UPDATING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
pub struct UpdateStatus {
    /// "none" | "orchestrator" | "full"
    pub mode: String,
    pub reason: String,
    pub busy: bool,
}

#[tauri::command]
pub fn check_update_status() -> Result<UpdateStatus, String> {
    let busy = UPDATING.load(Ordering::SeqCst);
    let ref_mtime = match running_binary_mtime() {
        Ok(t) => t,
        Err(e) => {
            return Ok(UpdateStatus {
                mode: "none".to_string(),
                reason: format!("ref binary mtime alınamadı: {}", e),
                busy,
            });
        }
    };

    let orch_newest = newest_mtime(Path::new(ORCHESTRATOR_SRC));
    let app_newest = newest_mtime(Path::new(APP_SRC));
    let tauri_newest = newest_mtime(Path::new(TAURI_SRC));
    let tpl_newest = newest_mtime(Path::new(TEMPLATES_DIR));

    let orch_changed = orch_newest.map(|t| t > ref_mtime).unwrap_or(false);
    let full_changed = [app_newest, tauri_newest, tpl_newest]
        .iter()
        .any(|opt| opt.map(|t| t > ref_mtime).unwrap_or(false));

    // Paketli app mı (.app bundle içinde) yoksa dev mi? Paketli app orchestrator'ı
    // .app içindeki bundled dist'ten çalıştırır → repo dist'ini rebuild edip
    // subprocess restart etmek eski kodu yükler (futile) + başlığı tazelemez. Bu
    // yüzden paketli app'te orchestrator-only değişiklik de "full" (tam rebuild +
    // .app swap + relaunch) ister. Dev mode'da hızlı yol doğru çalışır (repo dist
    // doğrudan koşulur), korunur.
    let is_packaged = current_app_bundle_path().is_ok();

    let (mode, reason) = if full_changed {
        let which = if app_newest.map(|t| t > ref_mtime).unwrap_or(false) {
            "frontend (src/)"
        } else if tauri_newest.map(|t| t > ref_mtime).unwrap_or(false) {
            "Tauri shell (src-tauri/src/)"
        } else {
            "templates (assets/templates/)"
        };
        ("full".to_string(), format!("{} değişti", which))
    } else if orch_changed {
        if is_packaged {
            (
                "full".to_string(),
                "orchestrator/src/ değişti (paketli app → tam güncelleme)".to_string(),
            )
        } else {
            (
                "orchestrator".to_string(),
                "orchestrator/src/ değişti".to_string(),
            )
        }
    } else {
        ("none".to_string(), "güncel".to_string())
    };

    Ok(UpdateStatus { mode, reason, busy })
}

#[tauri::command]
pub fn apply_update(
    app: AppHandle,
    state: State<OrchestratorState>,
    mode: String,
) -> Result<(), String> {
    if UPDATING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("güncelleme zaten sürüyor".to_string());
    }

    let result = match mode.as_str() {
        "orchestrator" => apply_orchestrator_update(&app, &state),
        "full" => apply_full_update(app.clone()),
        other => Err(format!("geçersiz mode: {}", other)),
    };

    // Full mode'da app.exit gecikmeli — guard'ı detached thread bırakacak.
    if mode != "full" || result.is_err() {
        UPDATING.store(false, Ordering::SeqCst);
    }
    result
}

/// Dev-mode hızlı yol: repo orchestrator/dist'ini rebuild + subprocess restart
/// (relaunch yok). Paketli app'te ÇAĞRILMAZ — check_update_status orada "full"
/// döndürür; çünkü çalışan orchestrator .app içindeki bundled dist'tir ve repo
/// dist'ini yenilemek ona ulaşmaz.
fn apply_orchestrator_update(
    app: &AppHandle,
    state: &OrchestratorState,
) -> Result<(), String> {
    // 1. TS build (sync). Finder-launched .app PATH'i minimal → npm absolute
    //    path ile çağrılır + child'a extended PATH (npm tsc spawn eder).
    //    stderr capture: build hatası UI'ya görünür hale gelsin (Stdio::null
    //    swallow ediyordu, kullanıcı "buton çalışmıyor" olarak görüyordu).
    let npm = crate::sys_path::find_executable("npm")?;
    let output = Command::new(&npm)
        .args(["--prefix", ORCHESTRATOR_DIR, "run", "build"])
        .env("PATH", crate::sys_path::extended_path())
        .output()
        .map_err(|e| format!("npm spawn: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail = stderr.lines().rev().take(20).collect::<Vec<_>>().iter().rev().cloned().collect::<Vec<_>>().join("\n");
        return Err(format!(
            "orchestrator build başarısız (exit {:?}):\n{}",
            output.status.code(),
            tail
        ));
    }

    // 2. Aktif session'ı kapat (varsa)
    let session_opt: Option<Session> = {
        let mut guard = state.session.lock();
        guard.take()
    };
    if let Some(session) = session_opt {
        stop_session(session);
    }

    // 3. Yeni session başlat
    let new_session = start_session(app)?;
    let mut guard = state.session.lock();
    *guard = Some(new_session);
    Ok(())
}

fn apply_full_update(app: AppHandle) -> Result<(), String> {
    let app_path = current_app_bundle_path()?;
    let parent_pid = std::process::id();
    let script_path = write_helper_script()?;

    // Detached spawn: stdio null + parent ölünce launchd reparent.
    // SOURCE_ROOT helper script'e 3. arg olarak geçer — hardcoded path yok.
    Command::new("/bin/bash")
        .arg(&script_path)
        .arg(app_path.to_string_lossy().to_string())
        .arg(parent_pid.to_string())
        .arg(SOURCE_ROOT)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("helper script spawn: {}", e))?;

    // 2 sn sonra uygulamadan çık — helper parent ölmesini bekliyor.
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(2000));
        UPDATING.store(false, Ordering::SeqCst);
        app.exit(0);
    });
    Ok(())
}

/// `std::env::current_exe()` → `.../MyCL Studio.app/Contents/MacOS/<bin>` → 3
/// ata yukarı `.app`. Yol `.app` ile bitmiyorsa Err (dev mode).
fn current_app_bundle_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {}", e))?;
    let app = exe
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .ok_or_else(|| ".app yolu çözümlenemedi".to_string())?;
    if app.extension().and_then(|s| s.to_str()) != Some("app") {
        return Err(format!(
            "binary bir .app bundle içinde değil (dev mode?): {}",
            app.display()
        ));
    }
    Ok(app.to_path_buf())
}

fn running_binary_mtime() -> Result<SystemTime, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {}", e))?;
    let meta = fs::metadata(&exe).map_err(|e| format!("stat {}: {}", exe.display(), e))?;
    meta.modified().map_err(|e| format!("mtime: {}", e))
}

/// Dizin altındaki tüm dosyaların en yeni mtime'ını döndür. Dizin yoksa None.
/// node_modules, dist, target, .git, .DS_Store atla.
fn newest_mtime(root: &Path) -> Option<SystemTime> {
    if !root.exists() {
        return None;
    }
    let mut newest: Option<SystemTime> = None;
    walk(root, &mut |p, meta| {
        if let Ok(t) = meta.modified() {
            if newest.map(|n| t > n).unwrap_or(true) {
                newest = Some(t);
            }
        }
        let _ = p;
    });
    newest
}

fn walk(dir: &Path, cb: &mut dyn FnMut(&Path, &fs::Metadata)) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if matches!(
            name_str.as_ref(),
            "node_modules" | "dist" | "target" | ".git" | ".DS_Store"
        ) {
            continue;
        }
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            walk(&path, cb);
        } else if meta.is_file() {
            cb(&path, &meta);
        }
    }
}

/// Helper script'i tmpdir'e yaz + chmod +x. Idempotent (varsa üstüne yazar).
/// UPDATING AtomicBool zaten apply_update'i serialize ettiği için ek kilit yok.
fn write_helper_script() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir();
    let path = dir.join("mycl-update-helper.sh");
    let mut f = fs::File::create(&path).map_err(|e| format!("script create: {}", e))?;
    f.write_all(HELPER_SCRIPT.as_bytes())
        .map_err(|e| format!("script write: {}", e))?;
    drop(f);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o755);
        fs::set_permissions(&path, perms).map_err(|e| format!("chmod: {}", e))?;
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newest_mtime_returns_none_for_missing() {
        let p = Path::new("/tmp/__mycl_nonexistent_xyz__");
        assert!(newest_mtime(p).is_none());
    }

    #[test]
    fn current_app_bundle_path_dev_mode_errors() {
        // Test runner dev mode'da çalışır → .app bundle dışı → Err
        let res = current_app_bundle_path();
        assert!(res.is_err(), "test'te .app yolu bulunmamalı");
    }
}
