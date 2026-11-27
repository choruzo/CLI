//! El atajo del Dot compacto, con la tecla mantenida (M25 fase 4, parte 3).
//!
//! ```text
//! Pressed ──► armada (plazo de 300 ms)
//!               │  Released antes del plazo ──► toque   («ask::toggle», como antes)
//!               │  el plazo vence ────────────► hablar   (compacto en «Listening…» y a grabar)
//!               ▼
//!            hablando ── Released ──► parar y transcribir
//! ```
//!
//! Esto es solo la **máquina de estados**: entra un evento con su instante y
//! sale lo que hay que hacer. No toca Tauri, ni la ventana, ni el micrófono: así
//! se prueba entera, incluidos los bordes.
//!
//! Dos reglas que se ven mejor aquí que en el resto:
//!
//!  - **La autorrepetición del sistema operativo no cuenta.** Mientras la tecla
//!    siga pulsada llegan más `Pressed`: todos se ignoran. Solo el primer
//!    `Pressed` de cada pulsación arma el plazo.
//!  - **El plazo es la única fuente de la decisión de hablar.** Si se suelta
//!    antes de que venza —también justo en el umbral—, es un toque. En el
//!    umbral exacto no hay nada grabado que transcribir y una nota de 300 ms no
//!    llegaría al mínimo de 0,5 s: abrir el compacto como un toque es lo único
//!    que no inventa una nota. El plazo, si venció, gana el empate.

use std::time::{Duration, Instant};

/// Cuánto hay que mantener la tecla para hablar en vez de abrir el compacto.
pub const HOLD: Duration = Duration::from_millis(300);

/// Lo que hay que hacer con la ventana o con la nota.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Un toque: abrir el compacto (o cerrarlo), como antes del push-to-talk.
    Tap,
    /// Hablar: abrir el compacto en «Listening…» y empezar a grabar.
    Talk,
    /// Soltar tras hablar: parar el micrófono y transcribir.
    Stop,
}

/// La máquina. Se guarda una por ventana del compacto y se consulta desde el
/// hilo del atajo.
#[derive(Debug, Default)]
pub struct Hold {
    /// El instante del `Pressed` que armó el plazo, si la tecla sigue abajo.
    armed_at: Option<Instant>,
    /// Se llegó a hablar y aún no se ha soltado.
    talking: bool,
}

impl Hold {
    /// La tecla bajó. Devuelve **cuándo vence el plazo** la primera vez, y `None`
    /// en la autorrepetición (la tecla ya estaba pulsada).
    pub fn pressed(&mut self, at: Instant) -> Option<Instant> {
        if self.talking || self.armed_at.is_some() {
            return None;
        }
        self.armed_at = Some(at);
        Some(at + HOLD)
    }

    /// La tecla subió. El instante se recibe por simetría con los otros dos
    /// eventos, pero no decide nada: lo que decide es si el plazo venció antes.
    pub fn released(&mut self, _at: Instant) -> Option<Action> {
        if self.armed_at.take().is_some() {
            // El plazo no había vencido: un toque, como siempre.
            return Some(Action::Tap);
        }
        if self.talking {
            self.talking = false;
            return Some(Action::Stop);
        }
        None
    }

    /// Venció el plazo de [`HOLD`]. Si la tecla ya se soltó (o el plazo es de
    /// una pulsación anterior), no pasa nada: por eso se compara el instante con
    /// el de la pulsación que armó el plazo, y no solo el orden de llegada.
    pub fn expired(&mut self, at: Instant) -> Option<Action> {
        let armed_at = self.armed_at?;
        if at.saturating_duration_since(armed_at) < HOLD {
            return None;
        }
        self.armed_at = None;
        self.talking = true;
        Some(Action::Talk)
    }

    /// Vuelve a «no pulsada»: no se pudo abrir el micrófono, se cerró el
    /// compacto o ya había otra nota.
    pub fn reset(&mut self) {
        self.armed_at = None;
        self.talking = false;
    }

    /// Se está hablando (la tecla sigue abajo y ya se graba). Lo mira el atajo
    /// para no empezar una nota que ya se soltó mientras esperaba el turno.
    pub fn is_talking(&self) -> bool {
        self.talking
    }

    /// La tecla está abajo, aún sin llegar al plazo.
    #[cfg(test)]
    pub fn is_armed(&self) -> bool {
        self.armed_at.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Instant {
        Instant::now()
    }

    #[test]
    fn un_toque_abre_el_compacto_como_siempre() {
        let mut hold = Hold::default();
        let t0 = base();
        assert_eq!(hold.pressed(t0), Some(t0 + HOLD));
        assert_eq!(
            hold.released(t0 + Duration::from_millis(90)),
            Some(Action::Tap)
        );
        // Y ya no queda nada: otra vuelta igual.
        assert!(hold.pressed(t0 + Duration::from_millis(200)).is_some());
        assert_eq!(
            hold.released(t0 + Duration::from_millis(220)),
            Some(Action::Tap)
        );
        assert!(!hold.is_talking());
    }

    #[test]
    fn mantener_la_tecla_graba_hasta_soltarla() {
        let mut hold = Hold::default();
        let t0 = base();
        hold.pressed(t0);
        // Antes del plazo, nada.
        assert_eq!(hold.expired(t0 + Duration::from_millis(299)), None);
        assert_eq!(hold.expired(t0 + HOLD), Some(Action::Talk));
        assert!(hold.is_talking());
        // Sigue pulsada: el plazo ya no vuelve a dispararse.
        assert_eq!(hold.expired(t0 + Duration::from_millis(900)), None);
        assert_eq!(
            hold.released(t0 + Duration::from_millis(1_500)),
            Some(Action::Stop)
        );
        assert!(!hold.is_talking());
        // Soltar otra vez, sin pulsar: nada.
        assert_eq!(hold.released(t0 + Duration::from_millis(1_600)), None);
    }

    #[test]
    fn las_repeticiones_de_la_tecla_no_cuentan() {
        let mut hold = Hold::default();
        let t0 = base();
        assert!(hold.pressed(t0).is_some());
        // La autorrepetición del sistema operativo: el plazo no se corre ni se
        // arma dos veces, y un toque sigue siendo un toque.
        for ms in [40_u64, 120, 200, 260] {
            assert_eq!(hold.pressed(t0 + Duration::from_millis(ms)), None);
        }
        assert_eq!(
            hold.released(t0 + Duration::from_millis(280)),
            Some(Action::Tap)
        );
    }

    #[test]
    fn soltar_justo_en_el_umbral() {
        // Si el plazo venció (empate), se habla: lo dice el plazo.
        let mut hold = Hold::default();
        let t0 = base();
        hold.pressed(t0);
        assert_eq!(hold.expired(t0 + HOLD), Some(Action::Talk));
        assert_eq!(hold.released(t0 + HOLD), Some(Action::Stop));

        // Y si se suelta justo en el umbral sin que el plazo haya disparado (el
        // temporizador llega tarde), no hay nada grabado: toque, nunca una nota
        // de 300 ms que el mínimo de 0,5 s tiraría de todas formas.
        let mut hold = Hold::default();
        hold.pressed(t0);
        assert_eq!(hold.released(t0 + HOLD), Some(Action::Tap));
        assert_eq!(hold.expired(t0 + HOLD), None);
    }

    #[test]
    fn el_plazo_de_una_pulsacion_vieja_no_abre_otra_nota() {
        let mut hold = Hold::default();
        let t0 = base();
        hold.pressed(t0);
        assert_eq!(
            hold.released(t0 + Duration::from_millis(100)),
            Some(Action::Tap)
        );
        // Segunda pulsación: su plazo vence 350 ms después de la primera.
        hold.pressed(t0 + Duration::from_millis(150));
        assert_eq!(hold.expired(t0 + HOLD), None, "el plazo es de la anterior");
        assert_eq!(
            hold.expired(t0 + Duration::from_millis(450)),
            Some(Action::Talk)
        );
    }

    #[test]
    fn mientras_habla_no_empieza_otra_nota() {
        let mut hold = Hold::default();
        let t0 = base();
        hold.pressed(t0);
        assert_eq!(hold.expired(t0 + HOLD), Some(Action::Talk));
        // La tecla sigue abajo (o llega un `Pressed` que se cruzó): no se arma
        // un plazo nuevo ni se reinicia la nota en curso.
        assert_eq!(hold.pressed(t0 + Duration::from_millis(500)), None);
        assert_eq!(hold.expired(t0 + Duration::from_millis(600)), None);
        assert_eq!(
            hold.released(t0 + Duration::from_millis(700)),
            Some(Action::Stop)
        );
    }

    #[test]
    fn resetear_deja_el_atajo_como_si_no_se_hubiera_pulsado() {
        let mut hold = Hold::default();
        let t0 = base();
        hold.pressed(t0);
        hold.expired(t0 + HOLD);
        hold.reset();
        assert!(!hold.is_talking() && !hold.is_armed());
        // Soltar ya no para nada, y una pulsación nueva empieza limpia.
        assert_eq!(hold.released(t0 + Duration::from_millis(400)), None);
        assert!(hold.pressed(t0 + Duration::from_millis(500)).is_some());
    }
}
