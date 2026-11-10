//! Modo código: las comprobaciones **locales** antes de pedir al daemon una
//! sesión del agente de código (la de la CLI) en una carpeta de proyecto.
//!
//! No deciden nada que no vuelva a decidir el daemon (él valida el `cwd` y el
//! perfil): solo evitan enviar lo que seguro que no vale y, sobre todo, que el
//! modo código abra o convierta una sesión en un agente embebido. Desktop no
//! crea la carpeta, no la registra y no toca `WorkspaceState`: la carpeta es del
//! usuario.

use dot_link::{CommandError, CommandErrorKind};
use std::path::Path;

/// Los agentes embebidos (`agent/presets.ts`, `EMBEDDED_AGENTS`): se eligen al
/// abrir una conversación, no son perfiles de agente de código.
pub const EMBEDDED_AGENTS: [&str; 2] = ["assistant", "companion"];

fn not_sent(message: &str) -> CommandError {
    CommandError::new(CommandErrorKind::NotSent, message)
}

/// Un perfil de agente de código, o ninguno. Un agente embebido no lo es
/// (sin distinguir mayúsculas: no se intenta colarlo con otra forma).
pub fn check_code_agent(agent: &Option<String>) -> Result<(), CommandError> {
    let Some(name) = agent.as_deref().map(str::trim) else {
        return Ok(());
    };
    if EMBEDDED_AGENTS
        .iter()
        .any(|embedded| name.eq_ignore_ascii_case(embedded))
    {
        return Err(not_sent(
            "Ese agente no es un perfil de código: el asistente se usa en las conversaciones.",
        ));
    }
    Ok(())
}

/// La carpeta del proyecto: absoluta, existente y un directorio. El daemon lo
/// vuelve a comprobar (y puede rechazarla por otros motivos).
pub fn check_project_dir(cwd: &str) -> Result<(), CommandError> {
    let path = Path::new(cwd);
    if cwd.is_empty() || !path.is_absolute() {
        return Err(not_sent(
            "La carpeta del proyecto tiene que ser una ruta absoluta.",
        ));
    }
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => Err(not_sent("La ruta del proyecto no es una carpeta.")),
        Err(_) => Err(not_sent(
            "La carpeta del proyecto no existe o no se puede leer.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_agente_embebido_no_es_un_perfil_de_codigo() {
        assert!(check_code_agent(&None).is_ok());
        assert!(check_code_agent(&Some("revisor".into())).is_ok());
        for embedded in ["assistant", "companion", " Assistant ", "COMPANION"] {
            let err = check_code_agent(&Some(embedded.into())).unwrap_err();
            assert_eq!(err.kind, CommandErrorKind::NotSent, "{embedded}");
        }
    }

    #[test]
    fn la_carpeta_es_absoluta_existe_y_es_un_directorio() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        assert!(check_project_dir(&root).is_ok());
        let file = dir.path().join("f.txt");
        std::fs::write(&file, "x").unwrap();
        for bad in [
            String::new(),
            "relativa/carpeta".to_string(),
            file.to_string_lossy().into_owned(),
            dir.path().join("no-existe").to_string_lossy().into_owned(),
        ] {
            let err = check_project_dir(&bad).unwrap_err();
            assert_eq!(err.kind, CommandErrorKind::NotSent, "{bad}");
        }
    }
}
