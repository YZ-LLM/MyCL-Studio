// recent — Son açılan proje klasörlerinin kalıcı listesi (max 20).
//
// Storage: Tauri app data path / `recent_projects.json`.
// macOS: ~/Library/Application Support/com.umitduman.myclv14/recent_projects.json
//
// API:
// - get_recent_projects() → Vec<String>  (en yeni başta)
// - add_recent_project(path) → ()        (dedupe + cap at 20)

use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const MAX_RECENT: usize = 20;
const FILE_NAME: &str = "recent_projects.json";

#[derive(Default, Serialize, Deserialize)]
struct RecentStore {
    paths: Vec<String>,
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir failed: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {}", e))?;
    Ok(dir.join(FILE_NAME))
}

fn load(app: &AppHandle) -> Result<RecentStore, String> {
    let p = store_path(app)?;
    if !p.exists() {
        return Ok(RecentStore::default());
    }
    let raw = std::fs::read_to_string(&p).map_err(|e| format!("read failed: {}", e))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse failed: {}", e))
}

fn save(app: &AppHandle, store: &RecentStore) -> Result<(), String> {
    let p = store_path(app)?;
    let raw = serde_json::to_string_pretty(store)
        .map_err(|e| format!("serialize failed: {}", e))?;
    std::fs::write(&p, raw).map_err(|e| format!("write failed: {}", e))
}

#[tauri::command]
pub fn get_recent_projects(app: AppHandle) -> Result<Vec<String>, String> {
    // Fallback YOK: load() error fırlatırsa caller (UI) görür ve karar verir.
    // `unwrap_or_default()` corrupt JSON'ı sessizce gizlerdi — kullanıcı kuralı
    // gereği yasak.
    let store = load(&app)?;
    let existing: Vec<String> = store
        .paths
        .into_iter()
        .filter(|p| std::path::Path::new(p).is_dir())
        .collect();
    Ok(existing)
}

#[tauri::command]
pub fn add_recent_project(app: AppHandle, path: String) -> Result<(), String> {
    // Aynı kural: load() fail → caller'a hata propagate.
    let mut store = load(&app)?;
    store.paths.retain(|p| p != &path);
    store.paths.insert(0, path);
    if store.paths.len() > MAX_RECENT {
        store.paths.truncate(MAX_RECENT);
    }
    save(&app, &store)
}

#[tauri::command]
pub fn clear_recent_projects(app: AppHandle) -> Result<(), String> {
    // Corrupt JSON sonrası recovery için: kullanıcı listeyi sıfırlayabilir.
    save(&app, &RecentStore::default())
}
