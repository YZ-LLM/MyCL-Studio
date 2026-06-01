// sys_path — Finder/Explorer'dan açılan paketlenmiş uygulamanın PATH'i minimaldir.
// `node`, `npm`, `git` vb. platforma göre farklı yerlerde (macOS: /opt/homebrew/bin;
// Linux: /usr/bin + login shell; Windows: Program Files\nodejs + `where`). Bu modül
// executable resolution + PATH enrichment'i PLATFORM-FARKINDA yapar.
//
// v15.8 (2026-06-01): Cross-platform. Önceden Unix-only (sabit /opt/homebrew + zsh)
// idi → Windows/Linux paketinde node hiç bulunamıyordu, orkestratör başlamıyordu.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;

use parking_lot::Mutex;

/// Resolved executable cache — name → absolute path. find_executable çağrıları
/// arasında paylaşılır (process lifecycle).
static EXE_CACHE: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, PathBuf>> {
    EXE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Verilen executable'ın absolute path'ini bul (platform-farkında). Cache: ilk
/// başarılı çözüm process lifecycle boyunca saklanır.
pub fn find_executable(name: &str) -> Result<PathBuf, String> {
    if let Some(hit) = cache().lock().get(name).cloned() {
        return Ok(hit);
    }
    if let Some(p) = platform_find(name) {
        cache().lock().insert(name.to_string(), p.clone());
        return Ok(p);
    }
    Err(format!(
        "'{name}' bulunamadı (PATH + bilinen kurulum konumları + login shell tarandı). \
         Lütfen sisteme kurun ve PATH'e ekleyin (node için nodejs.org)."
    ))
}

/// Unix (macOS + Linux + BSD): bilinen bin konumları → login shell `command -v`.
#[cfg(unix)]
fn platform_find(name: &str) -> Option<PathBuf> {
    let mut candidates: Vec<String> = Vec::new();
    // Homebrew (Apple Silicon) yalnız macOS'ta.
    #[cfg(target_os = "macos")]
    candidates.push(format!("/opt/homebrew/bin/{name}"));
    candidates.push(format!("/usr/local/bin/{name}"));
    candidates.push(format!("/usr/bin/{name}"));
    candidates.push(format!("/bin/{name}"));
    for c in candidates {
        let p = PathBuf::from(c);
        if p.is_file() {
            return Some(p);
        }
    }
    // Login shell fallback — kullanıcı profili (nvm/asdf/fnm) yüklensin. macOS
    // varsayılanı zsh, Linux genelde bash; mevcut olan ilk shell'le dene.
    for shell in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if !PathBuf::from(shell).is_file() {
            continue;
        }
        if let Some(p) = shell_which(shell, name) {
            return Some(p);
        }
    }
    None
}

/// Login shell ile `command -v <name>` çalıştırıp absolute path al (Unix).
#[cfg(unix)]
fn shell_which(shell: &str, name: &str) -> Option<PathBuf> {
    let out = std::process::Command::new(shell)
        .args(["-lc", &format!("command -v {name}")])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        return None;
    }
    let p = PathBuf::from(path);
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

/// Windows: bilinen kurulum konumları → `where.exe <name>`.
#[cfg(windows)]
fn platform_find(name: &str) -> Option<PathBuf> {
    let exe = if name.to_ascii_lowercase().ends_with(".exe") {
        name.to_string()
    } else {
        format!("{name}.exe")
    };
    for c in [
        format!("C:\\Program Files\\nodejs\\{exe}"),
        format!("C:\\Program Files (x86)\\nodejs\\{exe}"),
    ] {
        let p = PathBuf::from(&c);
        if p.is_file() {
            return Some(p);
        }
    }
    // `where` ilk eşleşmeyi döndürür (PATH + App Paths).
    if let Ok(o) = std::process::Command::new("where").arg(&exe).output() {
        if o.status.success() {
            let s = String::from_utf8_lossy(&o.stdout);
            if let Some(first) = s.lines().next() {
                let p = PathBuf::from(first.trim());
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// Spawn'lanan child process'lere geçirilecek genişletilmiş PATH (platform-farkında).
/// Bilinen bin konumları parent PATH'in başına eklenir → child kendisi npm/git
/// spawn ederken bulabilir. Ayraç Unix'te ':', Windows'ta ';'.
#[cfg(unix)]
pub fn extended_path() -> String {
    #[cfg(target_os = "macos")]
    let extras = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
    #[cfg(not(target_os = "macos"))]
    let extras = "/usr/local/bin:/usr/bin:/bin";
    match std::env::var("PATH") {
        Ok(p) if !p.is_empty() => format!("{extras}:{p}"),
        _ => extras.to_string(),
    }
}

#[cfg(windows)]
pub fn extended_path() -> String {
    let extras = "C:\\Program Files\\nodejs;C:\\Program Files (x86)\\nodejs";
    match std::env::var("PATH") {
        Ok(p) if !p.is_empty() => format!("{extras};{p}"),
        _ => extras.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extended_path_prepends_common_locations() {
        let p = extended_path();
        #[cfg(target_os = "macos")]
        assert!(p.contains("/opt/homebrew/bin"));
        #[cfg(unix)]
        assert!(p.contains("/usr/bin"));
        #[cfg(windows)]
        assert!(p.contains("nodejs"));
    }

    #[cfg(unix)]
    #[test]
    fn find_executable_finds_ls() {
        // ls /usr/bin veya /bin'de garanti (POSIX).
        let p = find_executable("ls").expect("ls bulunmalı");
        assert!(p.is_file());
        assert!(p.to_string_lossy().ends_with("/ls"));
    }

    #[cfg(unix)]
    #[test]
    fn find_executable_caches_result() {
        let p1 = find_executable("ls").expect("ls bulunmalı");
        let p2 = find_executable("ls").expect("ls bulunmalı");
        assert_eq!(p1, p2);
    }

    #[test]
    fn find_executable_missing_returns_err() {
        let res = find_executable("__definitely_not_a_real_binary_xyz__");
        assert!(res.is_err());
    }
}
