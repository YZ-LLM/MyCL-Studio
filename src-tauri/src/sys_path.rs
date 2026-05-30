// sys_path — Finder-launched .app PATH'i minimal (`/usr/bin:/bin:/usr/sbin:/sbin`).
// `node`, `npm`, `git` vb. `/opt/homebrew/bin`, `/usr/local/bin` veya nvm
// path'lerinde. `Command::new("node")` parent PATH'i inherit ettiği için ENOENT
// alır. Bu modül executable resolution + PATH enrichment yapar.

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

/// Verilen executable'ın absolute path'ini bul. Strateji:
///   1. Common absolute paths (deterministik, hızlı): /opt/homebrew/bin,
///      /usr/local/bin, /usr/bin
///   2. Login shell fallback (`/bin/zsh -lc 'command -v <name>'`) — nvm, asdf,
///      kullanıcı PATH'i için
///   3. Bulunamadıysa açıklayıcı hata
///
/// Cache: ilk başarılı çözüm process lifecycle boyunca saklanır.
pub fn find_executable(name: &str) -> Result<PathBuf, String> {
    if let Some(hit) = cache().lock().get(name).cloned() {
        return Ok(hit);
    }

    // 1. Common bin locations
    for candidate in [
        format!("/opt/homebrew/bin/{name}"),
        format!("/usr/local/bin/{name}"),
        format!("/usr/bin/{name}"),
    ] {
        let p = PathBuf::from(&candidate);
        if p.is_file() {
            cache().lock().insert(name.to_string(), p.clone());
            return Ok(p);
        }
    }

    // 2. Login shell fallback — kullanıcı profile (~/.zshrc, ~/.zprofile,
    //    nvm.sh source vb.) yüklensin ve `command -v` doğru path versin.
    let out = std::process::Command::new("/bin/zsh")
        .args(["-lc", &format!("command -v {name}")])
        .output();
    if let Ok(o) = out {
        if o.status.success() {
            let path = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !path.is_empty() {
                let p = PathBuf::from(&path);
                if p.is_file() {
                    cache().lock().insert(name.to_string(), p.clone());
                    return Ok(p);
                }
            }
        }
    }

    Err(format!(
        "'{name}' bulunamadı. Kontrol edilen: /opt/homebrew/bin, /usr/local/bin, /usr/bin, login shell (zsh -lc). \
         Lütfen sisteme kurun ve PATH'e ekleyin (örn. node için nodejs.org)."
    ))
}

/// Spawn'lanan child process'lere geçirilecek genişletilmiş PATH.
/// Common bin locations parent PATH'in başına eklenir → child kendisi npm/git
/// vb. spawn ederken bulabilir.
pub fn extended_path() -> String {
    let extras = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
    match std::env::var("PATH") {
        Ok(p) if !p.is_empty() => format!("{extras}:{p}"),
        _ => extras.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extended_path_contains_common_locations() {
        let p = extended_path();
        assert!(p.contains("/opt/homebrew/bin"));
        assert!(p.contains("/usr/local/bin"));
        assert!(p.contains("/usr/bin"));
    }

    #[test]
    fn find_executable_finds_ls() {
        // ls /usr/bin'de garanti var (POSIX standard)
        let p = find_executable("ls").expect("ls bulunmalı");
        assert!(p.is_file());
        assert!(p.to_string_lossy().ends_with("/ls"));
    }

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
