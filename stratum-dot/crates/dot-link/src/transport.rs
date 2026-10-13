//! Canal local con el daemon: named pipe (Windows) o unix socket (POSIX).
//! **Sin TCP** (`docs/protocol.md` §2): la dirección sale siempre del
//! descubrimiento, nunca de un host y un puerto.

use std::io;
use std::time::Duration;

#[cfg(windows)]
pub type Stream = tokio::net::windows::named_pipe::NamedPipeClient;
#[cfg(unix)]
pub type Stream = tokio::net::UnixStream;

/// Conecta con el canal de `path`. En Windows un pipe con todas sus instancias
/// ocupadas contesta `ERROR_PIPE_BUSY`: se reintenta durante `busy_wait`.
pub async fn connect(path: &str, busy_wait: Duration) -> io::Result<Stream> {
    #[cfg(windows)]
    {
        const ERROR_PIPE_BUSY: i32 = 231;
        let deadline = tokio::time::Instant::now() + busy_wait;
        loop {
            match tokio::net::windows::named_pipe::ClientOptions::new().open(path) {
                Ok(stream) => return Ok(stream),
                Err(e)
                    if e.raw_os_error() == Some(ERROR_PIPE_BUSY)
                        && tokio::time::Instant::now() < deadline =>
                {
                    tokio::time::sleep(Duration::from_millis(40)).await;
                }
                Err(e) => return Err(e),
            }
        }
    }
    #[cfg(unix)]
    {
        match tokio::time::timeout(busy_wait, tokio::net::UnixStream::connect(path)).await {
            Ok(result) => result,
            Err(_) => Err(io::Error::new(io::ErrorKind::TimedOut, "connect timed out")),
        }
    }
}
