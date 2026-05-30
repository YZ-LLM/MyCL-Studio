// MyCL Studio v14 — Tauri shell entry.
//
// Mimari (2-katmanlı — Claude Code CLI yok, v14 ADR-001):
//   Tauri (Rust shell, bu modül)
//     ↓ stdin/stdout NDJSON
//   Node.js orchestrator (state machine, gate logic, audit, translator)
//     ↓ Anthropic SDK direct API
//   Claude (cloud, custom tool definitions)
//
// Bu modül commands kayıt eder. Domain mantığı orchestrator/'da.

mod orchestrator;
mod recent;
mod sys_path;
mod updater;

use orchestrator::{
    get_open_projects, kill_orchestrator, kill_window, register_window_project,
    send_to_orchestrator, send_to_window, spawn_orchestrator,
    spawn_orchestrator_for_window, OrchestratorState,
};
use recent::{add_recent_project, clear_recent_projects, get_recent_projects};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use updater::{apply_update, check_update_status};

/// v15.2.2: Frontend'in yeni pencere açma komutu. Yeni `WebviewWindow` yaratır,
/// label `mycl-<uuid>` formatında. Frontend `getCurrentWindow().label` ile
/// bu label'ı okur → orchestrator-event:<label> dinler. Çağıran taraf
/// `spawn_orchestrator_for_window(label)` ile subprocess'i bağlamak zorunda.
///
/// QC v15.2.2 KRITIK-2 fix: pencere kapanırken backend tarafında subprocess'i
/// kill et (process leak koruması). React cleanup'a güvenmiyoruz — Tauri
/// `on_window_event Destroyed` ile doğrudan kill_window tetikleniyor.
#[tauri::command]
fn open_new_window(app: tauri::AppHandle) -> Result<String, String> {
    let label = format!(
        "{}{}",
        orchestrator::WINDOW_LABEL_PREFIX,
        uuid::Uuid::new_v4().simple()
    );
    // v15.2.3 borç (Tauri WebContext): pencere başına ayrı data_directory.
    // localStorage, cookies, sessionStorage paylaşımı engellenir; her
    // pencere kendi web context'inde çalışır. Path: app_data/windows/<label>/.
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir resolve failed: {}", e))?;
    let window_data_dir = app_data.join("windows").join(&label);
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("MyCL Studio")
        .inner_size(1440.0, 900.0)
        .min_inner_size(1024.0, 768.0)
        .decorations(true)
        .data_directory(window_data_dir)
        .build()
        .map_err(|e| format!("window create failed: {}", e))?;
    // İlk yüklendiğinde focus al — kullanıcı yeni pencereye baksın.
    let _ = window.set_focus();

    // Window close handler: pencere kapatıldığında subprocess'i temizle.
    // React unmount'a güvenmiyoruz; Tauri window destroyed event'i deterministik.
    let label_clone = label.clone();
    let app_clone = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            // State'den session'ı al ve stop_session çağır.
            let state = app_clone.state::<orchestrator::OrchestratorState>();
            let session_opt = {
                let mut guard = state.windows.lock();
                guard.remove(&label_clone)
            };
            if let Some(session) = session_opt {
                orchestrator::stop_session(session);
                eprintln!("[multi-window] subprocess stopped for label={}", label_clone);
            }
        }
    });

    Ok(label)
}

// v15.2.3 QC borç: uuid_v4_simple kaldırıldı, `uuid` crate ile değiştirildi
// (open_new_window içinde Uuid::new_v4().simple()). Collision rate 2^-122.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // v15.2.1: tauri-plugin-single-instance — aynı binary'nin ikinci exec'i
    // mevcut process'e relay yapar. Şu an handler sadece argv'i log'lar +
    // mevcut pencereyi focus eder. v15.2.2'de bu handler'da yeni pencere
    // açma logic'i + project_path argv parsing eklenecek. Default kullanıcı
    // davranışı (tek-pencere) etkilenmez.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            eprintln!(
                "[single-instance] secondary launch — argv={:?} cwd={}",
                argv, cwd
            );
            // Mevcut pencereyi öne getir (kullanıcı yanlışlıkla ikinci launch'ta
            // farklı pencere bekliyorsa görsel feedback). QC B v15.2.1: set_focus
            // hatası artık log'lanıyor (sessiz fail debug zorluğu).
            if let Some(window) = app.webview_windows().values().next() {
                if let Err(e) = window.set_focus() {
                    eprintln!("[single-instance] set_focus failed: {}", e);
                }
            }
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(OrchestratorState::default())
        .invoke_handler(tauri::generate_handler![
            get_recent_projects,
            add_recent_project,
            clear_recent_projects,
            spawn_orchestrator,
            send_to_orchestrator,
            kill_orchestrator,
            check_update_status,
            apply_update,
            // v15.2.2 multi-window komutları
            open_new_window,
            spawn_orchestrator_for_window,
            send_to_window,
            kill_window,
            // v15.7 (2026-05-24) — açık projeler registry (Splash filter için)
            register_window_project,
            get_open_projects,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
