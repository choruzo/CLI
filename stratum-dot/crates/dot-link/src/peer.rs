//! Quién atiende al otro lado del canal, **según el sistema operativo** (Q2,
//! `docs/dot.md` §14).
//!
//! Dot no envía el token del canal —ni, por la conexión de aprobador, la clave
//! de aprobador— sin preguntar antes al sistema quién es el proceso que ha
//! aceptado la conexión:
//!
//!  - **Linux / macOS** (unix socket): `SO_PEERCRED` / `LOCAL_PEERCRED` dan el
//!    uid y (donde existe) el pid del que escucha.
//!  - **Windows** (named pipe): `GetNamedPipeServerProcessId` da el pid del
//!    servidor del pipe, y el SID de usuario del token de ese proceso se compara
//!    con el de Dot.
//!
//! Lo que se exige: **el mismo usuario** que Dot y **el pid que publicó
//! `endpoint.json`**. Así un proceso que se adelante a crear el canal, o que
//! responda en un endpoint rancio, no recibe credenciales.
//!
//! Lo que esto **no** da: aislamiento frente a otro proceso del mismo usuario.
//! Ese proceso puede reescribir `endpoint.json` con su propio pid y su canal, y
//! pasaría esta comprobación. Mismo dominio de confianza, y así se documenta.
//!
//! Tampoco es identidad del **cliente**: esto lo comprueba Dot sobre el
//! daemon. El daemon (Node) no tiene API para leer las credenciales del par;
//! lo que él comprueba está en `docs/protocol.md` §15.3.

use std::fmt;

use crate::transport::Stream;

/// Lo que el sistema dijo del proceso al otro lado.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerFacts {
    /// `None`: el sistema no lo dijo (o la consulta falló).
    pub same_user: Option<bool>,
    pub pid: Option<u32>,
}

/// Qué se puede afirmar del par frente al endpoint publicado.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerCheck {
    /// Mismo usuario y el pid del endpoint, ambos confirmados por el sistema.
    Verified,
    /// Nada en contra, pero el sistema no confirmó todo (`what` dice qué faltó).
    Partial { what: &'static str },
}

/// El par **no** es el daemon que publicó el endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerMismatch {
    /// Lo atiende otro usuario del sistema.
    OtherUser,
    /// Lo atiende otro proceso (`pid`) que el que publicó el endpoint.
    OtherProcess { pid: u32 },
}

impl fmt::Display for PeerMismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PeerMismatch::OtherUser => f.write_str("the channel is served by another user"),
            PeerMismatch::OtherProcess { pid } => write!(
                f,
                "the channel is served by pid {pid}, not by the daemon that published the endpoint"
            ),
        }
    }
}

/// Puro: decide con lo que dijo el sistema. `expected_pid` es el del endpoint.
pub fn judge(facts: PeerFacts, expected_pid: u32) -> Result<PeerCheck, PeerMismatch> {
    if facts.same_user == Some(false) {
        return Err(PeerMismatch::OtherUser);
    }
    if let Some(pid) = facts.pid {
        if pid != expected_pid {
            return Err(PeerMismatch::OtherProcess { pid });
        }
    }
    match (facts.same_user, facts.pid) {
        (None, _) => Ok(PeerCheck::Partial { what: "user" }),
        (_, None) => Ok(PeerCheck::Partial { what: "pid" }),
        _ => Ok(PeerCheck::Verified),
    }
}

/// Pregunta al sistema por el proceso al otro lado de `stream`.
pub fn facts(stream: &Stream) -> PeerFacts {
    imp::facts(stream)
}

/// [`facts`] + [`judge`].
pub fn verify(stream: &Stream, expected_pid: u32) -> Result<PeerCheck, PeerMismatch> {
    judge(facts(stream), expected_pid)
}

#[cfg(unix)]
mod imp {
    use super::PeerFacts;
    use crate::transport::Stream;

    pub fn facts(stream: &Stream) -> PeerFacts {
        let Ok(cred) = stream.peer_cred() else {
            return PeerFacts {
                same_user: None,
                pid: None,
            };
        };
        // SAFETY: `geteuid` no falla ni toca memoria.
        let me = unsafe { libc::geteuid() };
        PeerFacts {
            same_user: Some(cred.uid() == me),
            pid: cred.pid().and_then(|p| u32::try_from(p).ok()),
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::PeerFacts;
    use crate::transport::Stream;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        EqualSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// El `TOKEN_USER` de un proceso, en un búfer propio (el SID va dentro).
    fn token_user(process: HANDLE) -> Option<Vec<u8>> {
        // SAFETY: llamadas Win32 sobre un handle válido; el token se cierra aquí.
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
                return None;
            }
            let mut needed = 0u32;
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed);
            if needed == 0 || needed > 4096 {
                CloseHandle(token);
                return None;
            }
            // u64 para que el `TOKEN_USER` del principio quede alineado.
            let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
            let ok = GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
            );
            CloseHandle(token);
            if ok == 0 {
                return None;
            }
            Some(buffer.iter().flat_map(|w| w.to_ne_bytes()).collect())
        }
    }

    fn same_user(pid: u32) -> Option<bool> {
        // SAFETY: handles que se cierran aquí; los SID se leen de búferes vivos.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return None;
            }
            let theirs = token_user(process);
            CloseHandle(process);
            let mine = token_user(GetCurrentProcess())?;
            let theirs = theirs?;
            let theirs: &TOKEN_USER = &*(theirs.as_ptr() as *const TOKEN_USER);
            let mine: &TOKEN_USER = &*(mine.as_ptr() as *const TOKEN_USER);
            Some(EqualSid(theirs.User.Sid, mine.User.Sid) != 0)
        }
    }

    pub fn facts(stream: &Stream) -> PeerFacts {
        let handle = stream.as_raw_handle() as HANDLE;
        let mut pid = 0u32;
        // SAFETY: `handle` es el del pipe abierto, vivo mientras dure `stream`.
        let ok = unsafe { GetNamedPipeServerProcessId(handle, &mut pid) };
        if ok == 0 || pid == 0 {
            return PeerFacts {
                same_user: None,
                pid: None,
            };
        }
        PeerFacts {
            same_user: same_user(pid),
            pid: Some(pid),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(same_user: Option<bool>, pid: Option<u32>) -> PeerFacts {
        PeerFacts { same_user, pid }
    }

    #[test]
    fn mismo_usuario_y_el_pid_del_endpoint_es_verificado() {
        assert_eq!(
            judge(facts(Some(true), Some(7)), 7),
            Ok(PeerCheck::Verified)
        );
    }

    #[test]
    fn otro_usuario_u_otro_proceso_no_pasan() {
        assert_eq!(
            judge(facts(Some(false), Some(7)), 7),
            Err(PeerMismatch::OtherUser)
        );
        assert_eq!(
            judge(facts(Some(true), Some(8)), 7),
            Err(PeerMismatch::OtherProcess { pid: 8 })
        );
        // Sin saber el usuario, un pid distinto ya basta para negarse.
        assert_eq!(
            judge(facts(None, Some(8)), 7),
            Err(PeerMismatch::OtherProcess { pid: 8 })
        );
    }

    #[test]
    fn lo_que_el_sistema_no_dice_queda_parcial() {
        assert_eq!(
            judge(facts(None, Some(7)), 7),
            Ok(PeerCheck::Partial { what: "user" })
        );
        assert_eq!(
            judge(facts(Some(true), None), 7),
            Ok(PeerCheck::Partial { what: "pid" })
        );
        assert_eq!(
            judge(facts(None, None), 7),
            Ok(PeerCheck::Partial { what: "user" })
        );
    }
}
