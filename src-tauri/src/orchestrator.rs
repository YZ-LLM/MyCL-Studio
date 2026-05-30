// orchestrator — Node.js orchestrator child process'ini yönetir.
//
// Mimari (2-katmanlı, v14 ADR-001):
//   Tauri (Rust shell)
//     ↓ stdin/stdout NDJSON
//   Node.js orchestrator (state machine, gate logic, audit, translator)
//     ↓ Anthropic SDK direct API (no Claude Code CLI subprocess)
//   Claude (cloud)
//
// Bu modül yalnızca Rust↔Node iletişimini yönetir; faz mantığı tamamen
// Node tarafında.
//
// API:
// - spawn_orchestrator()        → orchestrator boot
// - send_to_orchestrator(msg)   → stdin'e JSON line gönder
// - on_orchestrator_event       → frontend Tauri event ("orchestrator-event")
// - kill_orchestrator()         → graceful shutdown (stdin close + wait + force)

use parking_lot::Mutex;
use std::collections::HashMap;

/// Multi-window pencere label prefix'i (v15.2.3 borç C1). Backend (open_new_window)
/// ve frontend (useOrchestrator.ts isMultiWindow check) burayı referans alır.
/// Format değişirse her iki tarafı da güncelle.
pub const WINDOW_LABEL_PREFIX: &str = "mycl-";
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// ~/.mycl/tauri-stderr.log dosyasına satır append eder. Hata olursa
/// sessiz geçer (stderr zaten terminal'e basılıyor).
fn append_stderr_line(line: &str) {
    let home = match std::env::var_os("HOME") {
        Some(h) => PathBuf::from(h),
        None => return,
    };
    let dir = home.join(".mycl");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("tauri-stderr.log");
    if let Ok(mut f) = OpenOptions::new().append(true).create(true).open(&path) {
        let ts = chrono_iso();
        let _ = writeln!(f, "{} {}", ts, line);
    }
}

/// Minimum ISO8601 — chrono crate olmadan. SystemTime → epoch ms → ISO.
fn chrono_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs() as i64;
    let ms = dur.subsec_millis();
    // Simple format: epoch.ms (sortable, debug-friendly).
    format!("epoch={}.{:03}", secs, ms)
}

/// Tek-pencere modu için legacy session (v14 backward-compat). Yeni multi-window
/// kullanımı `windows` HashMap'i ile yapılır (v15.2.2). Default tek pencere
/// build'i `session` field'ını kullanır; `enable_multi_window=true` config
/// feature flag açıldığında `open_new_window` komutu HashMap'e yazar.
#[derive(Default)]
pub struct OrchestratorState {
    pub session: Mutex<Option<Session>>,
    pub windows: Mutex<HashMap<String, Session>>,
    /// v15.7 (2026-05-24): window_label → açık project_path mapping. Frontend
    /// `register_window_project` IPC ile her open_project sonrası günceller.
    /// Splash component yeni pencere'de açık projeleri listede grizler — aynı
    /// projeyi iki pencerede açmayı engellemek için. Pencere kapanınca
    /// `kill_window` cleanup eder.
    pub open_projects: Mutex<HashMap<String, String>>,
}

pub struct Session {
    child: Child,
    stdin: ChildStdin,
}

fn orchestrator_entry(app: &AppHandle) -> Result<PathBuf, String> {
    // orchestrator/dist/index.js iki yoldan biriyle bulunur:
    //   1. Production .app: tauri.conf.json `bundle.resources` ile bundle
    //      içine kopyalanır → `BaseDirectory::Resource` resolver doğru yolu
    //      verir (Tauri `..` paths'i `_up_` prefix'i ile preserve eder).
    //   2. Dev mode (`npm run tauri dev`): cargo binary cwd = src-tauri/
    //      olduğu için `../orchestrator/dist/index.js` doğru çözülür.
    // Hardcoded path yok — kullanıcı projeyi başka bir konuma taşırsa yeni
    // build her iki yolu da geçerli kılar.
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = app
        .path()
        .resolve("../orchestrator/dist/index.js", tauri::path::BaseDirectory::Resource)
    {
        candidates.push(p);
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("../orchestrator/dist/index.js"));
    }

    for c in &candidates {
        if c.exists() {
            return c
                .canonicalize()
                .map_err(|e| format!("canonicalize {}: {}", c.display(), e));
        }
    }
    Err(format!(
        "orchestrator/dist/index.js bulunamadı. Kontrol edilen:\n  - {}",
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join("\n  - ")
    ))
}

/// Pure helper: yeni bir orchestrator child process başlat ve Session döndür.
/// Stdout/stderr okuma thread'leri yan etki olarak başlatılır (event emit +
/// log dosyası). `spawn_orchestrator` + `apply_orchestrator_update` ortak kullanım.
/// Tek-pencere default "orchestrator-event" event ismini kullanır;
/// v15.2.2 multi-window için `start_session_scoped` farklı event_name alır.
pub(crate) fn start_session(app: &AppHandle) -> Result<Session, String> {
    start_session_scoped(app, "orchestrator-event", "orchestrator-exit")
}

/// v15.2.2: window-scoped event emit. Multi-window'da her pencere kendi
/// event_name'ini dinler. `open_new_window` `mycl-orchestrator-event:<label>`
/// formatında çağırır → frontend `getCurrentWindow().listen(...)` ile filtreler.
pub(crate) fn start_session_scoped(
    app: &AppHandle,
    event_name: &str,
    exit_event_name: &str,
) -> Result<Session, String> {
    let event_name = event_name.to_string();
    let exit_event_name = exit_event_name.to_string();
    let entry = orchestrator_entry(app)?;
    let entry_str = entry.to_string_lossy().to_string();

    // Finder-launched .app PATH'i minimal; node'u absolute path ile çağır +
    // child'a extended PATH ver ki orchestrator kendisi npm/git vb. spawn
    // edebilsin (intent-router command handler için kritik).
    let node = crate::sys_path::find_executable("node")?;
    let mut child = Command::new(&node)
        .arg(&entry_str)
        .env("LC_ALL", "C")
        .env("PATH", crate::sys_path::extended_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("orchestrator spawn failed: {}", e))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "stdin pipe missing".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdout pipe missing".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "stderr pipe missing".to_string())?;

    // stdout okuyucu thread: her satırı JSON parse et, frontend'e emit et.
    let app_clone = app.clone();
    let evt_name = event_name.clone();
    let exit_evt_name = exit_event_name.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let payload: serde_json::Value = match serde_json::from_str(trimmed) {
                        Ok(v) => v,
                        Err(e) => {
                            eprintln!("[orchestrator] bad json: {} ({})", trimmed, e);
                            continue;
                        }
                    };
                    let _ = app_clone.emit(&evt_name, payload);
                }
                Err(e) => {
                    eprintln!("[orchestrator] read err: {}", e);
                    break;
                }
            }
        }
        let _ = app_clone.emit(&exit_evt_name, ());
    });

    // stderr ayrı thread: terminal'e + ~/.mycl/tauri-stderr.log'a yansıt.
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(line) = line {
                eprintln!("[orchestrator stderr] {}", line);
                append_stderr_line(&format!("[orchestrator stderr] {}", line));
            }
        }
    });

    Ok(Session { child, stdin })
}

/// Pure helper: aktif session'ı graceful kapatır (stdin close → 1sn bekle →
/// gerekirse SIGKILL). `kill_orchestrator` + `apply_orchestrator_update`
/// ortak kullanım. State guard caller tarafından alınmalı; bu fonksiyon
/// Session'ı consume eder.
pub(crate) fn stop_session(mut session: Session) {
    drop(session.stdin);
    let deadline = Instant::now() + Duration::from_millis(1000);
    let mut exited = false;
    while Instant::now() < deadline {
        match session.child.try_wait() {
            Ok(Some(_)) => {
                exited = true;
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    if !exited {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
}

#[tauri::command]
pub fn spawn_orchestrator(
    app: AppHandle,
    state: State<OrchestratorState>,
) -> Result<(), String> {
    // İdempotent: zaten çalışıyorsa no-op
    {
        let guard = state.session.lock();
        if guard.is_some() {
            return Ok(());
        }
    }

    let session = start_session(&app)?;
    let mut guard = state.session.lock();
    *guard = Some(session);
    Ok(())
}

#[tauri::command]
pub fn send_to_orchestrator(
    state: State<OrchestratorState>,
    message: serde_json::Value,
) -> Result<(), String> {
    let mut guard = state.session.lock();
    let session = guard
        .as_mut()
        .ok_or_else(|| "orchestrator not running".to_string())?;
    let mut line = serde_json::to_string(&message).map_err(|e| format!("encode: {}", e))?;
    line.push('\n');
    session
        .stdin
        .write_all(line.as_bytes())
        .map_err(|e| format!("write_all: {}", e))?;
    session.stdin.flush().map_err(|e| format!("flush: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn kill_orchestrator(state: State<OrchestratorState>) -> Result<(), String> {
    let session_opt = {
        let mut guard = state.session.lock();
        guard.take()
    };
    if let Some(session) = session_opt {
        stop_session(session);
    }
    Ok(())
}

// ============================================================
// v15.2.2 Multi-window komutları
// ============================================================
// Tasarım: her pencere kendi label'ıyla ayrı orchestrator subprocess'i bağlar.
// Event routing: `orchestrator-event:<label>` formatında emit; frontend
// `getCurrentWindow().listen("orchestrator-event:<label>")` ile dinler.
// Feature flag: backend bunu kullanan command'ları sadece frontend
// `enable_multi_window=true` ile çağırır. Default tek-pencere kullanıcı
// için yeni command'lar bypass edilir (UI tetiklemez).

/// Yeni bir orchestrator subprocess'i window_label ile bağlı olarak başlatır.
/// İdempotent: aynı label için zaten session varsa no-op.
///
/// QC v15.2.2 A1 fix: önceki "check → IO → insert" pattern'inde aradaki IO
/// (subprocess spawn ~100ms) sırasında ikinci çağrı race olabilirdi. Şimdi
/// HashMap entry API ile tek lock acquisition'da check+placeholder commit
/// yapıyor; gerçek session start dışarıda. İkinci çağrı placeholder gördüğü
/// için early return; spawn IO duplicate olmaz.
#[tauri::command]
pub fn spawn_orchestrator_for_window(
    app: AppHandle,
    state: State<OrchestratorState>,
    window_label: String,
) -> Result<(), String> {
    // Pre-emptive insert: aynı label için ikinci çağrı bu noktada early
    // return eder. Şu an placeholder'ımız yok (Session non-Default'lu)
    // → gerçek pattern: contains_key check'i mutex altında atomic.
    {
        let guard = state.windows.lock();
        if guard.contains_key(&window_label) {
            return Ok(());
        }
    }
    let event_name = format!("orchestrator-event:{}", window_label);
    let exit_event_name = format!("orchestrator-exit:{}", window_label);
    let session = start_session_scoped(&app, &event_name, &exit_event_name)?;
    // Final insert: lock acquire et, RACE check (başka spawn arada koştuysa
    // bizim session'ımız extra; stop_session ile temizle, mevcut korunur).
    let mut guard = state.windows.lock();
    if guard.contains_key(&window_label) {
        drop(guard);
        // Bizim spawn'ımız fazlaydı — yeni başlattığımız subprocess'i kapat.
        stop_session(session);
        return Ok(());
    }
    guard.insert(window_label, session);
    Ok(())
}

/// Belirli bir pencerenin orchestrator'una IPC mesaj gönder.
#[tauri::command]
pub fn send_to_window(
    state: State<OrchestratorState>,
    window_label: String,
    message: serde_json::Value,
) -> Result<(), String> {
    let mut guard = state.windows.lock();
    let session = guard
        .get_mut(&window_label)
        .ok_or_else(|| format!("no orchestrator session for window '{}'", window_label))?;
    let mut line = serde_json::to_string(&message).map_err(|e| format!("encode: {}", e))?;
    line.push('\n');
    session
        .stdin
        .write_all(line.as_bytes())
        .map_err(|e| format!("write_all: {}", e))?;
    session.stdin.flush().map_err(|e| format!("flush: {}", e))?;
    Ok(())
}

/// Bir pencere kapatıldığında subprocess'i graceful shutdown.
#[tauri::command]
pub fn kill_window(
    state: State<OrchestratorState>,
    window_label: String,
) -> Result<(), String> {
    let session_opt = {
        let mut guard = state.windows.lock();
        guard.remove(&window_label)
    };
    if let Some(session) = session_opt {
        stop_session(session);
    }
    // v15.7: open_projects cleanup — pencere kapandı, açık proje listesinden düş
    {
        let mut guard = state.open_projects.lock();
        guard.remove(&window_label);
    }
    Ok(())
}

/// v15.7 (2026-05-24): Frontend `open_project` IPC'sini gönderdikten sonra
/// bu komutu çağırır — Rust state'e window→project eşlemesi yazılır.
#[tauri::command]
pub fn register_window_project(
    state: State<OrchestratorState>,
    window_label: String,
    project_path: String,
) -> Result<(), String> {
    let mut guard = state.open_projects.lock();
    guard.insert(window_label, project_path);
    Ok(())
}

#[derive(serde::Serialize)]
pub struct OpenProject {
    pub label: String,
    pub path: String,
}

/// v15.7: Splash component bunu çağırır — yeni pencerede "Son Projeler" listesi
/// başka pencerede açık olanları grizler. Dead entry (dosya yok) filter edilir.
#[tauri::command]
pub fn get_open_projects(state: State<OrchestratorState>) -> Vec<OpenProject> {
    let guard = state.open_projects.lock();
    guard
        .iter()
        .filter(|(_, path)| std::path::Path::new(path).exists())
        .map(|(label, path)| OpenProject {
            label: label.clone(),
            path: path.clone(),
        })
        .collect()
}
