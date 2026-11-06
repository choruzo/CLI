//! La confirmación nativa de un cambio de ajustes de nivel B.
//!
//! Es la misma ventana y las mismas reglas que la confirmación de aprobar
//! (`confirm.rs`, `docs/dot.md` §14) con otra cosa que confirmar. No reutiliza
//! `dot_link::ConfirmGate` porque ese está atado a las solicitudes del daemon
//! (lee del daemon qué se confirma y entrega una `ConfirmedAction` al broker de
//! aprobar), y un ajuste no pasa por ninguno de los dos: el daemon ni se entera.
//!
//! Reglas (las del puerto de Dot):
//!
//!  - lo que se enseña lo arma el lado nativo ([`ConfirmRequest`], de
//!    `settings.rs`); el webview solo dijo **qué clave** quiere cambiar;
//!  - **una a la vez**: con una abierta, otra petición se rechaza, y tras
//!    cancelar hay una pausa corta;
//!  - **nunca se confirma sola**: solo [`SettingsGate::confirm`] con el `nonce` de
//!    la ventana abierta, pasado el tiempo mínimo desde que se enseñó, una vez;
//!  - **caduca** por plazo y al cerrar Desktop; cerrar la ventana es no confirmar;
//!  - caducada o cancelada, no se escribe nada (quien llama no recibe el visto bueno).
//!
//! En el log, qué clave; nunca el valor.

use crate::settings::{not_confirmed, ConfirmRequest, Confirmer};
use dot_link::state::{CommandError, CommandErrorKind};
use dot_link::{Logger, Presenter};
use serde_json::{json, Value};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub struct SettingsTimings {
    /// Cuánto puede estar abierta.
    pub ttl: Duration,
    /// Desde que se enseña hasta que se puede confirmar.
    pub arm_delay: Duration,
    /// Tras cancelar o caducar, cuánto hasta poder abrir otra.
    pub cooldown: Duration,
}

impl Default for SettingsTimings {
    fn default() -> Self {
        Self {
            ttl: Duration::from_secs(120),
            arm_delay: Duration::from_millis(800),
            cooldown: Duration::from_millis(500),
        }
    }
}

/// Por qué `confirm` no dio el visto bueno.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmFailure {
    pub message: String,
    /// `true`: la ventana sigue abierta y se puede reintentar.
    pub keep_open: bool,
}

enum Outcome {
    Confirmed,
    Cancelled(&'static str),
}

struct Ticket {
    nonce: String,
    view: Value,
    shown_at: Option<Instant>,
    deadline: Instant,
    reply: Sender<Outcome>,
}

#[derive(Default)]
struct State {
    ticket: Option<Ticket>,
    cooldown_until: Option<Instant>,
}

pub struct SettingsGate {
    state: Mutex<State>,
    timings: SettingsTimings,
    logger: Logger,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 128 bits del generador del sistema operativo. Sin él no se abre nada.
fn new_nonce() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Lo que lee la página de confirmación (`confirm/confirm.js`), en el mismo
/// molde que la de aprobar: `kind`, `action`, `requestId`, `notes`, caducidad y
/// espera mínima; los datos propios, en `settings`.
fn view_of(request: &ConfirmRequest, timings: &SettingsTimings, nonce: &str) -> Value {
    json!({
        "kind": "settings",
        "action": "Cambiar el ajuste",
        "requestId": nonce,
        "runId": null,
        "session": {},
        "approval": null,
        "answers": [],
        "plan": null,
        "pairing": null,
        "settings": {
            "label": request.label,
            "key": request.key,
            "old": request.old,
            "new": request.new,
        },
        "notes": request.note.iter().collect::<Vec<_>>(),
        "expiresAt": now_ms() + timings.ttl.as_millis() as u64,
        "armMs": timings.arm_delay.as_millis() as u64,
    })
}

impl SettingsGate {
    pub fn new(timings: SettingsTimings, logger: Logger) -> Self {
        Self {
            state: Mutex::new(State::default()),
            timings,
            logger,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// El `nonce` de la confirmación abierta (para servir su página).
    pub fn current_nonce(&self) -> Option<String> {
        self.lock().ticket.as_ref().map(|t| t.nonce.clone())
    }

    /// Lo que enseñar de la confirmación con ese `nonce`, si sigue abierta.
    pub fn view(&self, nonce: &str) -> Option<Value> {
        let state = self.lock();
        let ticket = state.ticket.as_ref().filter(|t| t.nonce == nonce)?;
        (Instant::now() < ticket.deadline).then(|| ticket.view.clone())
    }

    /// La ventana ya enseña el cambio (se sirvió su página): la espera mínima
    /// vuelve a contar desde aquí.
    pub fn shown(&self, nonce: &str) {
        if let Some(ticket) = self.lock().ticket.as_mut().filter(|t| t.nonce == nonce) {
            ticket.shown_at = Some(Instant::now());
        }
    }

    fn end(&self, nonce: &str, outcome: Outcome) -> bool {
        let ticket = {
            let mut state = self.lock();
            if state.ticket.as_ref().map(|t| t.nonce.as_str()) != Some(nonce) {
                return false;
            }
            if matches!(outcome, Outcome::Cancelled(_)) {
                state.cooldown_until = Some(Instant::now() + self.timings.cooldown);
            }
            state.ticket.take()
        };
        let Some(ticket) = ticket else { return false };
        let _ = ticket.reply.send(outcome);
        true
    }

    /// La persona canceló (o cerró la ventana) la confirmación `nonce`.
    pub fn cancel(&self, nonce: &str) {
        self.end(nonce, Outcome::Cancelled("cancelled"));
    }

    /// Cancela la abierta, sea cual sea (Desktop se cierra).
    pub fn invalidate(&self) {
        if let Some(nonce) = self.current_nonce() {
            self.end(&nonce, Outcome::Cancelled("closing"));
        }
    }

    /// La persona pulsó «Confirmar» en la ventana `nonce`.
    pub fn confirm(&self, nonce: &str) -> Result<(), ConfirmFailure> {
        let closed = || ConfirmFailure {
            message: "Esta confirmación ya no está abierta.".into(),
            keep_open: false,
        };
        {
            let state = self.lock();
            let Some(ticket) = state.ticket.as_ref().filter(|t| t.nonce == nonce) else {
                return Err(closed());
            };
            let now = Instant::now();
            if now >= ticket.deadline {
                drop(state);
                self.end(nonce, Outcome::Cancelled("expired"));
                return Err(ConfirmFailure {
                    message: "La confirmación caducó. No se ha escrito nada.".into(),
                    keep_open: false,
                });
            }
            let armed = ticket
                .shown_at
                .is_some_and(|at| now.duration_since(at) >= self.timings.arm_delay);
            if !armed {
                return Err(ConfirmFailure {
                    message: "Lee el cambio antes de confirmar.".into(),
                    keep_open: true,
                });
            }
        }
        if self.end(nonce, Outcome::Confirmed) {
            Ok(())
        } else {
            Err(closed())
        }
    }

    /// Pide a la persona que confirme `request` y espera. Bloquea el hilo:
    /// se llama desde un hilo de trabajo, nunca desde el de la interfaz.
    /// `Ok` solo si confirmó en la ventana nativa.
    pub fn request(
        &self,
        presenter: &dyn Presenter,
        request: &ConfirmRequest,
    ) -> Result<(), CommandError> {
        {
            let state = self.lock();
            if state.ticket.is_some() {
                return Err(CommandError::new(
                    CommandErrorKind::NotSent,
                    "Hay otra confirmación abierta. Termínala o cancélala primero.",
                ));
            }
            if state.cooldown_until.is_some_and(|t| Instant::now() < t) {
                return Err(CommandError::new(
                    CommandErrorKind::NotSent,
                    "Espera un momento antes de pedir otra confirmación.",
                ));
            }
        }
        let nonce = new_nonce().ok_or_else(|| {
            CommandError::new(
                CommandErrorKind::NotSent,
                "No se pudo abrir la confirmación (sin aleatoriedad del sistema).",
            )
        })?;
        let (reply, outcome) = channel();
        {
            let mut state = self.lock();
            if state.ticket.is_some() {
                return Err(CommandError::new(
                    CommandErrorKind::NotSent,
                    "Hay otra confirmación abierta. Termínala o cancélala primero.",
                ));
            }
            self.logger
                .info(&format!("settings confirm: opened key={}", request.key));
            state.ticket = Some(Ticket {
                nonce: nonce.clone(),
                view: view_of(request, &self.timings, &nonce),
                shown_at: None,
                deadline: Instant::now() + self.timings.ttl,
                reply,
            });
        }
        struct Done<'a> {
            gate: &'a SettingsGate,
            nonce: &'a str,
            presenter: &'a dyn Presenter,
        }
        impl Drop for Done<'_> {
            fn drop(&mut self) {
                // Pase lo que pase, la confirmación no queda abierta ni la ventana viva.
                self.gate.end(self.nonce, Outcome::Cancelled("cancelled"));
                self.presenter.close();
            }
        }
        let _done = Done {
            gate: self,
            nonce: &nonce,
            presenter,
        };
        if presenter.show(&nonce).is_err() {
            return Err(CommandError::new(
                CommandErrorKind::NotSent,
                "No se pudo abrir la ventana de confirmación. No se ha escrito nada.",
            ));
        }
        if let Some(ticket) = self.lock().ticket.as_mut().filter(|t| t.nonce == nonce) {
            ticket.shown_at.get_or_insert_with(Instant::now);
        }
        match outcome.recv_timeout(self.timings.ttl) {
            Ok(Outcome::Confirmed) => {
                self.logger
                    .info(&format!("settings confirm: confirmed key={}", request.key));
                Ok(())
            }
            Ok(Outcome::Cancelled(reason)) => Err(refused(reason)),
            Err(_) => {
                self.end(&nonce, Outcome::Cancelled("expired"));
                Err(refused("expired"))
            }
        }
    }
}

fn refused(reason: &str) -> CommandError {
    let message = match reason {
        "expired" => "La confirmación caducó. No se ha escrito nada.",
        "closing" => "Stratum Desktop se está cerrando. No se ha escrito nada.",
        _ => "Sin confirmar. No se ha escrito nada.",
    };
    not_confirmed(reason, message)
}

/// El [`Confirmer`] de los ajustes: la ventana nativa de confirmación.
pub struct WindowConfirmer<'a> {
    pub gate: &'a SettingsGate,
    pub presenter: &'a dyn Presenter,
}

impl Confirmer for WindowConfirmer<'_> {
    fn confirm(&self, request: &ConfirmRequest) -> Result<(), CommandError> {
        self.gate.request(self.presenter, request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    fn request() -> ConfirmRequest {
        ConfirmRequest {
            label: "Confirmar lo destructivo".into(),
            key: "tools.confirmDestructive".into(),
            old: Some("sí".into()),
            new: Some("no".into()),
            note: None,
        }
    }

    fn quick() -> SettingsTimings {
        SettingsTimings {
            ttl: Duration::from_millis(600),
            arm_delay: Duration::from_millis(60),
            cooldown: Duration::from_millis(80),
        }
    }

    /// Qué hace «la persona» cuando se abre la ventana.
    #[derive(Clone, Copy)]
    enum Person {
        Confirms,
        /// Pulsa antes de que pase la espera mínima, y después ya no.
        ConfirmsTooSoon,
        Cancels,
        ClosesTheWindow,
        Ignores,
    }

    struct Window {
        gate: Arc<SettingsGate>,
        person: Person,
        closed: Arc<AtomicBool>,
        fail_to_open: bool,
        early: Arc<Mutex<Option<ConfirmFailure>>>,
    }

    impl Presenter for Window {
        fn show(&self, nonce: &str) -> Result<(), String> {
            if self.fail_to_open {
                return Err("sin ventana".into());
            }
            let (gate, nonce, person, early) = (
                self.gate.clone(),
                nonce.to_string(),
                self.person,
                self.early.clone(),
            );
            std::thread::spawn(move || {
                // La página se sirve → empieza a contar la espera.
                gate.shown(&nonce);
                match person {
                    Person::Confirms => {
                        std::thread::sleep(Duration::from_millis(120));
                        let _ = gate.confirm(&nonce);
                    }
                    Person::ConfirmsTooSoon => {
                        *early.lock().unwrap() = gate.confirm(&nonce).err();
                        std::thread::sleep(Duration::from_millis(120));
                        let _ = gate.confirm(&nonce);
                    }
                    Person::Cancels | Person::ClosesTheWindow => gate.cancel(&nonce),
                    Person::Ignores => {}
                }
            });
            Ok(())
        }
        fn close(&self) {
            self.closed.store(true, Ordering::SeqCst);
        }
    }

    fn window(gate: &Arc<SettingsGate>, person: Person) -> Window {
        Window {
            gate: gate.clone(),
            person,
            closed: Arc::new(AtomicBool::new(false)),
            fail_to_open: false,
            early: Arc::new(Mutex::new(None)),
        }
    }

    fn gate() -> Arc<SettingsGate> {
        Arc::new(SettingsGate::new(quick(), Logger::none()))
    }

    #[test]
    fn confirmar_en_la_ventana_da_el_visto_bueno_y_la_cierra() {
        let gate = gate();
        let w = window(&gate, Person::Confirms);
        gate.request(&w, &request()).unwrap();
        assert!(w.closed.load(Ordering::SeqCst));
        assert!(gate.current_nonce().is_none());
    }

    #[test]
    fn cancelar_o_cerrar_la_ventana_es_no_confirmar() {
        for person in [Person::Cancels, Person::ClosesTheWindow] {
            let gate = gate();
            let err = gate
                .request(&window(&gate, person), &request())
                .unwrap_err();
            assert_eq!(err.kind, CommandErrorKind::NotConfirmed);
            assert_eq!(err.reason.as_deref(), Some("cancelled"));
            assert!(err.message.contains("No se ha escrito nada"));
        }
    }

    #[test]
    fn sin_respuesta_caduca_y_no_da_el_visto_bueno() {
        let gate = gate();
        let w = window(&gate, Person::Ignores);
        let err = gate.request(&w, &request()).unwrap_err();
        assert_eq!(err.reason.as_deref(), Some("expired"));
        assert!(w.closed.load(Ordering::SeqCst));
        assert!(gate.current_nonce().is_none());
    }

    #[test]
    fn si_la_ventana_no_se_puede_abrir_no_hay_visto_bueno() {
        let gate = gate();
        let mut w = window(&gate, Person::Confirms);
        w.fail_to_open = true;
        let err = gate.request(&w, &request()).unwrap_err();
        assert_eq!(err.kind, CommandErrorKind::NotSent);
        assert!(gate.current_nonce().is_none());
    }

    #[test]
    fn un_clic_antes_de_la_espera_minima_no_confirma() {
        let gate = gate();
        let w = window(&gate, Person::ConfirmsTooSoon);
        let early = w.early.clone();
        gate.request(&w, &request()).unwrap();
        let first = early
            .lock()
            .unwrap()
            .clone()
            .expect("el primer clic debió rechazarse");
        assert!(first.keep_open);
        assert!(first.message.contains("Lee el cambio"));
    }

    #[test]
    fn una_confirmacion_a_la_vez_y_una_pausa_tras_cancelar() {
        let gate = gate();
        let g2 = gate.clone();
        let handle =
            std::thread::spawn(move || g2.request(&window(&g2, Person::Ignores), &request()));
        // Esperar a que la primera esté abierta.
        for _ in 0..50 {
            if gate.current_nonce().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let err = gate
            .request(&window(&gate, Person::Confirms), &request())
            .unwrap_err();
        assert_eq!(err.kind, CommandErrorKind::NotSent);
        assert!(err.message.contains("otra confirmación"));
        gate.invalidate();
        assert_eq!(
            handle.join().unwrap().unwrap_err().reason.as_deref(),
            Some("closing")
        );
        // Recién cancelada: hay que esperar un momento.
        let err = gate
            .request(&window(&gate, Person::Confirms), &request())
            .unwrap_err();
        assert!(err.message.contains("Espera un momento"));
        std::thread::sleep(Duration::from_millis(100));
        gate.request(&window(&gate, Person::Confirms), &request())
            .unwrap();
    }

    #[test]
    fn solo_vale_el_nonce_de_la_confirmacion_abierta() {
        let gate = gate();
        assert!(gate.confirm("cualquiera").is_err());
        assert!(gate.view("cualquiera").is_none());
        gate.cancel("cualquiera"); // no hace nada
        let g2 = gate.clone();
        let handle =
            std::thread::spawn(move || g2.request(&window(&g2, Person::Ignores), &request()));
        for _ in 0..50 {
            if gate.current_nonce().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let nonce = gate.current_nonce().unwrap();
        assert!(gate.confirm("otro-nonce").is_err());
        assert!(gate.view(&nonce).is_some());
        gate.cancel(&nonce);
        assert!(handle.join().unwrap().is_err());
        // Ya cerrada: confirmar con el nonce viejo no vale.
        assert!(gate.confirm(&nonce).is_err());
    }

    #[test]
    fn la_vista_lleva_la_clave_y_los_valores_pero_nunca_un_secreto() {
        let secret = ConfirmRequest {
            label: "Clave de API · nube".into(),
            key: "provider.providers.nube.apiKey".into(),
            old: None,
            new: None,
            note: Some("Se cambiará la clave de API del provider «nube».".into()),
        };
        let view = view_of(&secret, &quick(), "n1");
        let text = view.to_string();
        assert!(text.contains("provider.providers.nube.apiKey"));
        assert!(text.contains("Se cambiará la clave de API"));
        assert_eq!(view["kind"], "settings");
        assert_eq!(view["armMs"], 60);
        let plain = view_of(&request(), &quick(), "n2");
        assert_eq!(plain["settings"]["old"], "sí");
        assert_eq!(plain["settings"]["new"], "no");
    }
}
