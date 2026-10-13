//! Reglas de entrega de una suscripción (`docs/protocol.md` §9), sin E/S: qué
//! eventos se pasan, cuáles se descartan y cuándo hay que pedir una foto.
//!
//! Es la parte de `stratum-cli/src/client/subscriptions.ts` que Dot necesita, y
//! más pequeña porque Dot **siempre** se suscribe pidiendo foto (nunca
//! `sinceSeq`): al conectar y al reconectar la foto es la autoridad.
//!
//!  1. un evento de estado con `seq` ≤ el último entregado se descarta;
//!  2. un `seq` que salta es una pérdida: se pide otra foto y se ignora lo que
//!     llegue hasta recibirla;
//!  3. una foto sustituye: desde ella se sigue por su `seq`;
//!  4. un fragmento volátil con `after` menor que el último `seq` llega tarde.

use serde_json::Value;
use std::collections::HashMap;

/// Estado de la suscripción a una sesión.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSub {
    /// Id que le dio el servidor. `None` mientras se abre (o tras perder la conexión).
    pub server_id: Option<String>,
    /// `seq` de la última foto o del último evento de estado entregado.
    pub last_seq: Option<u64>,
    /// Se pidió una foto: lo que llegue antes de ella se ignora.
    pub awaiting_snapshot: bool,
    /// Recibe también los fragmentos de texto (solo la sesión enfocada).
    pub volatile: bool,
    /// Cambia en cada reapertura: la respuesta de una apertura vieja no se enlaza.
    pub generation: u32,
}

impl SessionSub {
    pub fn new(volatile: bool) -> Self {
        Self {
            server_id: None,
            last_seq: None,
            awaiting_snapshot: true,
            volatile,
            generation: 0,
        }
    }

    /// Hay que volver a abrirla: la respuesta en vuelo, si la hay, ya no vale.
    pub fn reopen(&mut self, volatile: bool) -> Option<String> {
        self.generation = self.generation.wrapping_add(1);
        self.awaiting_snapshot = true;
        self.last_seq = None;
        self.volatile = volatile;
        self.server_id.take()
    }

    /// Llegó una foto. Devuelve `false` si no es de esta sesión o no trae `seq`.
    pub fn on_snapshot(&mut self, session_id: &str, snapshot: &Value) -> bool {
        let Some(seq) = snapshot.get("seq").and_then(Value::as_u64) else {
            return false;
        };
        let id = snapshot
            .get("session")
            .and_then(|s| s.get("id"))
            .and_then(Value::as_str);
        if id != Some(session_id) {
            return false;
        }
        self.last_seq = Some(seq);
        self.awaiting_snapshot = false;
        true
    }

    /// Filtra un lote. Devuelve lo que se entrega, en orden, y si hay que
    /// resincronizar (un hueco): en ese caso lo que quedaba del lote se descarta.
    pub fn on_events(&mut self, session_id: &str, events: Vec<Value>) -> (Vec<Value>, bool) {
        let mut out = Vec::new();
        for event in events {
            if self.awaiting_snapshot {
                break;
            }
            if event.get("sessionId").and_then(Value::as_str) != Some(session_id) {
                continue;
            }
            if let Some(seq) = event.get("seq").and_then(Value::as_u64) {
                if let Some(last) = self.last_seq {
                    if seq <= last {
                        continue;
                    }
                    if seq > last + 1 {
                        self.awaiting_snapshot = true;
                        return (out, true);
                    }
                }
                self.last_seq = Some(seq);
                out.push(event);
            } else if let Some(after) = event.get("after").and_then(Value::as_u64) {
                if matches!(self.last_seq, Some(last) if after < last) {
                    continue;
                }
                out.push(event);
            }
            // Ni `seq` ni `after`: no es un evento del contrato.
        }
        (out, false)
    }
}

/// Lo que la suscripción de conjunto dice sobre qué sesiones hay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Membership {
    Opened(String),
    Closed(String),
}

/// Estado de la suscripción de conjunto. Dot solo la usa para saber **qué
/// sesiones existen**: el estado de cada una viene de su propia suscripción.
#[derive(Debug, Default)]
pub struct OverviewSub {
    pub server_id: Option<String>,
    seq_by_session: HashMap<String, u64>,
}

impl OverviewSub {
    /// Foto de conjunto: sustituye. Devuelve los ids de las sesiones vivas.
    pub fn on_overview(&mut self, overview: &Value) -> Vec<String> {
        self.seq_by_session.clear();
        let mut ids = Vec::new();
        for session in overview
            .get("sessions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(id) = session.get("id").and_then(Value::as_str) else {
                continue;
            };
            let seq = session.get("seq").and_then(Value::as_u64).unwrap_or(0);
            self.seq_by_session.insert(id.to_string(), seq);
            ids.push(id.to_string());
        }
        ids
    }

    /// Eventos de conjunto. Aquí los saltos de `seq` son normales (solo llegan
    /// algunos tipos): solo se deduplica.
    pub fn on_events(&mut self, events: &[Value]) -> Vec<Membership> {
        let mut out = Vec::new();
        for event in events {
            let (Some(kind), Some(session_id), Some(seq)) = (
                event.get("type").and_then(Value::as_str),
                event.get("sessionId").and_then(Value::as_str),
                event.get("seq").and_then(Value::as_u64),
            ) else {
                continue;
            };
            let known = self.seq_by_session.get(session_id).copied();
            if matches!(known, Some(last) if seq <= last) {
                continue;
            }
            if kind == "session.closed" {
                self.seq_by_session.remove(session_id);
                out.push(Membership::Closed(session_id.to_string()));
            } else {
                self.seq_by_session.insert(session_id.to_string(), seq);
                // Cualquier evento de una sesión que no se conocía la da de alta.
                if known.is_none() {
                    out.push(Membership::Opened(session_id.to_string()));
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state(seq: u64) -> Value {
        json!({ "type": "tool.started", "sessionId": "s1", "seq": seq, "at": 1, "data": {} })
    }

    fn delta(after: u64) -> Value {
        json!({ "type": "message.delta", "sessionId": "s1", "after": after, "at": 1, "data": { "text": "x" } })
    }

    fn snapshot(seq: u64) -> Value {
        json!({ "seq": seq, "session": { "id": "s1" } })
    }

    fn synced(seq: u64) -> SessionSub {
        let mut sub = SessionSub::new(true);
        assert!(sub.on_snapshot("s1", &snapshot(seq)));
        sub
    }

    #[test]
    fn nada_se_entrega_antes_de_la_foto() {
        let mut sub = SessionSub::new(true);
        assert_eq!(
            sub.on_events("s1", vec![state(5), delta(5)]),
            (vec![], false)
        );
        assert!(sub.on_snapshot("s1", &snapshot(5)));
        assert_eq!(sub.on_events("s1", vec![state(6)]).0, vec![state(6)]);
    }

    #[test]
    fn descarta_lo_ya_visto_y_sigue_en_orden() {
        let mut sub = synced(10);
        let (out, resync) = sub.on_events("s1", vec![state(9), state(10), state(11), state(12)]);
        assert_eq!(out, vec![state(11), state(12)]);
        assert!(!resync);
        assert_eq!(sub.last_seq, Some(12));
    }

    #[test]
    fn un_hueco_pide_foto_y_descarta_el_resto() {
        let mut sub = synced(10);
        let (out, resync) = sub.on_events("s1", vec![state(11), state(13), state(14)]);
        assert_eq!(out, vec![state(11)]);
        assert!(resync);
        assert!(sub.awaiting_snapshot);
        // Hasta la foto nueva, nada.
        assert_eq!(sub.on_events("s1", vec![state(12)]), (vec![], false));
        assert!(sub.on_snapshot("s1", &snapshot(14)));
        assert_eq!(
            sub.on_events("s1", vec![state(14), state(15)]).0,
            vec![state(15)]
        );
    }

    #[test]
    fn un_fragmento_tardio_se_descarta_y_los_demas_pasan() {
        let mut sub = synced(10);
        let (out, _) = sub.on_events(
            "s1",
            vec![delta(9), delta(10), state(11), delta(10), delta(11)],
        );
        assert_eq!(out, vec![delta(10), state(11), delta(11)]);
    }

    #[test]
    fn ignora_eventos_de_otra_sesion_y_los_que_no_son_del_contrato() {
        let mut sub = synced(1);
        let other = json!({ "type": "x", "sessionId": "s2", "seq": 2 });
        let shapeless = json!({ "type": "x", "sessionId": "s1" });
        assert_eq!(sub.on_events("s1", vec![other, shapeless]), (vec![], false));
        assert_eq!(sub.last_seq, Some(1));
    }

    #[test]
    fn una_foto_de_otra_sesion_o_sin_seq_no_vale() {
        let mut sub = SessionSub::new(false);
        assert!(!sub.on_snapshot("s2", &snapshot(3)));
        assert!(!sub.on_snapshot("s1", &json!({ "session": { "id": "s1" } })));
        assert!(sub.awaiting_snapshot);
    }

    #[test]
    fn reabrir_invalida_la_apertura_anterior() {
        let mut sub = synced(4);
        sub.server_id = Some("sub_1".into());
        let generation = sub.generation;
        assert_eq!(sub.reopen(false), Some("sub_1".into()));
        assert_ne!(sub.generation, generation);
        assert!(sub.awaiting_snapshot && sub.last_seq.is_none() && !sub.volatile);
    }

    #[test]
    fn la_foto_de_conjunto_da_los_ids_y_sustituye() {
        let mut ov = OverviewSub::default();
        let ids = ov.on_overview(
            &json!({ "sessions": [{ "id": "a", "seq": 3 }, { "id": "b", "seq": 0 }] }),
        );
        assert_eq!(ids, vec!["a", "b"]);
        assert_eq!(
            ov.on_overview(&json!({ "sessions": [{ "id": "b", "seq": 9 }] })),
            vec!["b"]
        );
        // `a` ya no se conoce: un evento suyo la vuelve a dar de alta.
        let ev = json!({ "type": "run.started", "sessionId": "a", "seq": 4 });
        assert_eq!(ov.on_events(&[ev]), vec![Membership::Opened("a".into())]);
    }

    #[test]
    fn altas_bajas_y_duplicados_en_el_conjunto() {
        let mut ov = OverviewSub::default();
        ov.on_overview(&json!({ "sessions": [{ "id": "a", "seq": 3 }] }));
        let opened = json!({ "type": "session.opened", "sessionId": "b", "seq": 1 });
        let dup = json!({ "type": "session.updated", "sessionId": "a", "seq": 3 });
        // En el conjunto los saltos son normales: 3 → 7 no es una pérdida.
        let jump = json!({ "type": "run.started", "sessionId": "a", "seq": 7 });
        let closed = json!({ "type": "session.closed", "sessionId": "a", "seq": 8 });
        let volatile = json!({ "type": "message.delta", "sessionId": "a", "after": 8 });
        assert_eq!(
            ov.on_events(&[opened.clone(), dup, jump, closed, volatile, opened]),
            vec![
                Membership::Opened("b".into()),
                Membership::Closed("a".into())
            ]
        );
    }
}
