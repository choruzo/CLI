/// Los comandos de la app, declarados: así cada uno exige un permiso y una
/// ventana solo puede invocar los que su capacidad le concede
/// (`capabilities/default.json`, solo `main`). La ventana de desbloqueo no está
/// en ninguna capacidad: no puede invocar nada.
const COMMANDS: &[&str] = &[
    "dot_attach",
    "dot_retry",
    "dot_focus_session",
    "dot_resync_session",
    "dot_pause_run",
    "dot_resume_run",
    "dot_cancel_run",
    "dot_steer_run",
    "dot_open_session",
    "dot_start_run",
    "dot_list_agents",
    "dot_list_models",
    "dot_box_status",
    "dot_box_start",
    "dot_box_stop",
    "dot_box_screen",
    "dot_approver_status",
    "dot_approver_unlock",
    "dot_approver_lock",
    "dot_approve",
    "dot_deny",
    "dot_answer_questions",
    "dot_decide_plan",
    "dot_set_attention",
    "dot_hide",
    "dot_quit",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run the Tauri build script");
}
