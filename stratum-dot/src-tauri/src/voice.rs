//! M25 fase 4 — la voz en Dot: la nota la graba el **lado nativo**.
//!
//! ```text
//! cpal (WASAPI) ──► mono f32 @ 48 kHz ──► FIR Blackman 63 + diezmado ×3 ──► PCM16 @ 16 kHz
//!   (hilo de audio)                          (en memoria)                        │
//!                                                                                ▼
//!                          voice.begin ─► voice.append ×N ─► voice.end ─────► stratumd
//! ```
//!
//! Reglas que no se rompen:
//!
//!  - **El audio nunca va a disco, al log ni al webview.** Solo vive en memoria y
//!    sale hacia el daemon por el enlace (`voice.*`, `docs/protocol.md` §35). Al
//!    terminar o cancelar se suelta.
//!  - **El micrófono se abre en el acto** (abrir tarda) y `voice.begin` va a la
//!    vez: lo grabado mientras tanto espera en memoria y se sube primero.
//!  - **Una nota a la vez** y como mucho 300 s: al llegar se para el micrófono
//!    sola y lo grabado queda para `stop()`.
//!  - **Menos de 0,5 s no se transcribe**: se tira con `voice.cancel`.
//!  - Lo que contesta el daemon vuelve **sin interpretar** (`serde_json::Value`):
//!    quien lo usa es el webview, con los schemas del contrato.
//!  - **Cada nota sabe quién la empezó** ([`Origin`]): el botón del chat
//!    (`Main`) o el atajo del Dot compacto (`Shortcut`). Perder el foco de la
//!    ventana principal tira solo las suyas; la del atajo se graba con el
//!    compacto delante.
//!  - La del atajo **no sabe de qué sesión es**: se resuelve dentro de la tarea,
//!    con el micrófono ya abierto, pidiendo la del asistente (`Session::Companion`).
//!
//! El remuestreo es el mismo de la CLI (`stratum-cli/src/voice/resample.ts`),
//! portado tal cual: FIR de fase lineal (sinc enventanado con Blackman, 63
//! coeficientes, corte 7,2 kHz) y **después** diezmado por 3. La muestra `m` de
//! salida es el instante `3m` de la entrada, sin retardo de grupo.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use dot_link::{CallAction, CommandError, CommandErrorKind, LinkHandle, Logger};
use serde_json::Value;

/// Frecuencia del PCM que entiende el daemon (`TARGET_SAMPLE_RATE` de la CLI).
pub const TARGET_SAMPLE_RATE: u32 = 16_000;

/// Frecuencia de la que se baja: la del micrófono en Windows (WASAPI).
const CAPTURE_SAMPLE_RATE: u32 = 48_000;

/// Coeficientes del FIR. Impar, para que su centro caiga en una muestra.
const TAPS: usize = 63;

/// Medio FIR: la ventana de la muestra de salida va de `3m - HALF` a `3m + HALF`.
const HALF: usize = (TAPS - 1) / 2;

/// Diezmado: 48 000 / 16 000.
const FACTOR: usize = 3;

/// Corte del paso bajo, en Hz. Por debajo del Nyquist de 16 kHz (8 kHz).
const CUTOFF_HZ: f64 = 7_200.0;

/// Cada cuánto mira el bucle de subida si hay algo que mandar. Es corto porque
/// lo que se gana es que al soltar el botón solo falte la cola.
const PUMP_INTERVAL: Duration = Duration::from_millis(10);

/// Cuánto espera `cancel()` a que el bucle suelte la subida. Si `begin` aún no
/// ha contestado, no se hace esperar al webview por eso: se suelta la tarea.
const CANCEL_WAIT: Duration = Duration::from_secs(5);

/// Ni micrófono ni permiso.
const NO_MICROPHONE: &str = "No microphone available.";

/// El agente que pide una nota del atajo (`docs/protocol.md` §22).
const COMPANION_AGENT: &str = "companion";

/// El fondo de la escala del nivel: por debajo de esto, silencio.
const MIN_DBFS: f32 = -100.0;

/// Candado de un `Mutex` que no se envenena: aquí no hay estado a medio escribir.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn not_sent(message: impl Into<String>) -> CommandError {
    CommandError::new(CommandErrorKind::NotSent, message)
}

fn nothing_recording() -> CommandError {
    CommandError::new(CommandErrorKind::Invalid, "No note is being recorded.")
}

// ---------------------------------------------------------------- remuestreo

/// FIR paso bajo de fase lineal: sinc truncado y enventanado con Blackman,
/// normalizado para que la ganancia en continua sea exactamente 1.
fn design_low_pass() -> [f64; TAPS] {
    let half = HALF as f64;
    let fc = CUTOFF_HZ / CAPTURE_SAMPLE_RATE as f64; // ciclos por muestra, 0..0.5
    let mut coefficients = [0.0f64; TAPS];
    let mut sum = 0.0;
    for (k, coefficient) in coefficients.iter_mut().enumerate() {
        let t = k as f64 - half;
        // sinc(2·fc·t) = sin(2·π·fc·t) / (π·t), con el límite 2·fc en t = 0.
        let sinc = if t == 0.0 {
            2.0 * fc
        } else {
            (2.0 * std::f64::consts::PI * fc * t).sin() / (std::f64::consts::PI * t)
        };
        let w = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * k as f64 / (TAPS - 1) as f64).cos()
            + 0.08 * (4.0 * std::f64::consts::PI * k as f64 / (TAPS - 1) as f64).cos();
        *coefficient = sinc * w;
        sum += *coefficient;
    }
    for coefficient in coefficients.iter_mut() {
        *coefficient /= sum;
    }
    coefficients
}

/// De 48 kHz a 16 kHz **en streaming**: da los mismos números que pasar la señal
/// entera de una vez, porque guarda entre trozos la parte de la ventana que aún
/// hace falta.
pub struct VoiceResampler {
    coefficients: [f64; TAPS],
    /// Entrada recibida y todavía sin consumir, con el índice global de la primera.
    pending: Vec<f32>,
    base: usize,
    /// Muestra de salida que toca emitir.
    next_out: usize,
    /// Muestras de entrada recibidas hasta ahora.
    received: usize,
}

impl Default for VoiceResampler {
    fn default() -> Self {
        Self::new()
    }
}

impl VoiceResampler {
    pub fn new() -> Self {
        Self {
            coefficients: design_low_pass(),
            pending: Vec::new(),
            base: 0,
            next_out: 0,
            received: 0,
        }
    }

    /// Añade un trozo de entrada y saca las salidas que ya se pueden calcular
    /// (las que no dependen de muestras que aún no han llegado).
    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        self.pending.extend_from_slice(input);
        self.received += input.len();
        self.emit(false, out);
    }

    /// Fin de la entrada: lo que falta de la última ventana son ceros, igual que
    /// al filtrar la señal entera (así salen `floor(n / 3)` muestras).
    pub fn finish(&mut self, out: &mut Vec<f32>) {
        self.emit(true, out);
    }

    fn emit(&mut self, at_end: bool, out: &mut Vec<f32>) {
        let out_len = self.received / FACTOR;
        while self.next_out < out_len {
            let center = self.next_out * FACTOR;
            // Sin fin, la ventana entera tiene que haber llegado.
            if !at_end && center + HALF >= self.received {
                break;
            }
            let start = center as i64 - HALF as i64;
            let mut acc = 0.0f64;
            for (k, coefficient) in self.coefficients.iter().enumerate() {
                let index = start + k as i64;
                if index < 0 || index >= self.received as i64 {
                    continue; // bordes: los ceros de fuera
                }
                if let Some(sample) = (index as usize)
                    .checked_sub(self.base)
                    .and_then(|at| self.pending.get(at))
                {
                    acc += coefficient * *sample as f64;
                }
            }
            out.push(acc as f32);
            self.next_out += 1;
        }
        // Lo que ya no se va a volver a mirar se suelta: una nota de 300 s no
        // deja 57 MB de entrada en memoria.
        let keep = (self.next_out * FACTOR).saturating_sub(HALF);
        if keep > self.base {
            let drop = (keep - self.base).min(self.pending.len());
            self.pending.drain(..drop);
            self.base += drop;
        }
    }
}

// ------------------------------------------------------------------ la captura

/// Lo que recibe una fuente de audio: muestras **mono en f32**.
pub type FrameSink = Box<dyn FnMut(&[f32]) + Send>;

/// De dónde salen las muestras: el micrófono (`cpal`) o, en los tests, una
/// fuente falsa. La fuente entrega **mono en f32**: mezclar canales es cosa suya.
pub trait AudioSource: Send {
    /// Frecuencia de lo que entrega.
    fn sample_rate(&self) -> u32;
    /// Empieza a entregar muestras a `sink`. Se llama una vez.
    fn start(&mut self, sink: FrameSink) -> Result<(), String>;
    /// Para la captura. Se puede llamar dos veces.
    fn stop(&mut self);
}

/// Cómo se abre el micrófono: el real, o una fuente de pruebas.
pub type SourceFactory = Arc<dyn Fn() -> Result<Box<dyn AudioSource>, String> + Send + Sync>;

/// Aviso de «está escuchando / ya no»: la bandeja lo pinta.
pub type Listener = Arc<dyn Fn(bool) + Send + Sync>;

/// El micrófono por defecto del sistema (`cpal`: WASAPI en Windows).
///
/// El flujo vive en **su propio hilo**, no en una tarea: en algunas plataformas
/// `cpal::Stream` no es `Send` y no puede cruzar de ahí. Lo que cruza es el
/// `sink`, y parar es poner una bandera y esperar a que el hilo cierre.
pub struct CpalSource {
    rate: u32,
    channels: usize,
    control: Option<CaptureThread>,
}

struct CaptureThread {
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl CpalSource {
    /// Abre el dispositivo por defecto y comprueba que va a una frecuencia que
    /// sabemos llevar a 16 kHz. No arranca la captura.
    pub fn open() -> Result<Self, String> {
        let (rate, channels) = input_format()?;
        // 48 000 se filtra y se diezma; 16 000 se pasa tal cual. Otra cosa, no:
        // un remuestreo arbitrario cambiaría el sonido y no está medido.
        if rate != CAPTURE_SAMPLE_RATE && rate != TARGET_SAMPLE_RATE {
            return Err(format!("Microphone at {rate} Hz is not supported."));
        }
        Ok(Self {
            rate,
            channels,
            control: None,
        })
    }
}

impl AudioSource for CpalSource {
    fn sample_rate(&self) -> u32 {
        self.rate
    }

    fn start(&mut self, sink: FrameSink) -> Result<(), String> {
        if self.control.is_some() {
            return Ok(());
        }
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let channels = self.channels;
        let (ready, opened) = std::sync::mpsc::channel::<Result<(), String>>();
        let join = std::thread::Builder::new()
            .name("dot-voice".into())
            .spawn(move || {
                // El flujo se crea y se suelta en este hilo: aquí vive entero.
                match open_stream(channels, sink, &flag) {
                    Ok(stream) => {
                        let _ = ready.send(Ok(()));
                        while !flag.load(Ordering::SeqCst) {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        drop(stream);
                    }
                    Err(message) => {
                        flag.store(true, Ordering::SeqCst);
                        let _ = ready.send(Err(message));
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        match opened.recv() {
            Ok(Ok(())) => {
                self.control = Some(CaptureThread {
                    stop,
                    join: Some(join),
                });
                Ok(())
            }
            Ok(Err(message)) => {
                let _ = join.join();
                Err(message)
            }
            Err(_) => Err("The microphone did not open.".into()),
        }
    }

    fn stop(&mut self) {
        let Some(control) = self.control.take() else {
            return;
        };
        control.stop.store(true, Ordering::SeqCst);
        if let Some(join) = control.join {
            let _ = join.join();
        }
    }
}

impl Drop for CpalSource {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Dispositivo de entrada por defecto: su frecuencia y sus canales.
fn input_format() -> Result<(u32, usize), String> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| NO_MICROPHONE.to_string())?;
    let supported = device
        .default_input_config()
        .map_err(|error| error.to_string())?;
    Ok((
        supported.sample_rate().0,
        supported.channels().max(1) as usize,
    ))
}

/// Abre el flujo de entrada y lo deja sonando. `sink` recibe mono en f32: los
/// canales se mezclan aquí y el formato del dispositivo se convierte aquí.
fn open_stream(
    channels: usize,
    mut sink: FrameSink,
    stop: &Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| NO_MICROPHONE.to_string())?;
    let supported = device
        .default_input_config()
        .map_err(|error| error.to_string())?;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let on_error = |stop: &Arc<AtomicBool>| {
        let stop = stop.clone();
        move |_error: cpal::StreamError| stop.store(true, Ordering::SeqCst)
    };
    let stream = match format {
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config,
            move |frames: &[i16], _: &_| sink(&mono_i16(frames, channels)),
            on_error(stop),
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config,
            move |frames: &[u16], _: &_| sink(&mono_u16(frames, channels)),
            on_error(stop),
            None,
        ),
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config,
            move |frames: &[f32], _: &_| sink(&mono_f32(frames, channels)),
            on_error(stop),
            None,
        ),
        other => {
            return Err(format!("Microphone format {other:?} is not supported."));
        }
    }
    .map_err(|error| error.to_string())?;
    stream.play().map_err(|error| error.to_string())?;
    Ok(stream)
}

/// Mezcla a mono (la media de los canales) un bloque de `i16`.
fn mono_i16(frames: &[i16], channels: usize) -> Vec<f32> {
    mix(frames, channels, |sample| sample as f32 / 32_768.0)
}

/// Mezcla a mono un bloque de `u16` (0 = −32768).
fn mono_u16(frames: &[u16], channels: usize) -> Vec<f32> {
    mix(frames, channels, |sample| {
        (sample as f32 - 32_768.0) / 32_768.0
    })
}

/// Mezcla a mono un bloque de `f32` (ya normalizado).
fn mono_f32(frames: &[f32], channels: usize) -> Vec<f32> {
    mix(frames, channels, |sample| sample)
}

/// La media de cada grupo de `channels` muestras. Un bloque a medias deja la
/// última trama como esté: el driver no parte una trama entre dos callbacks.
fn mix<T: Copy>(frames: &[T], channels: usize, to_f32: impl Fn(T) -> f32) -> Vec<f32> {
    let channels = channels.max(1);
    frames
        .chunks(channels)
        .map(|frame| {
            let sum: f32 = frame.iter().map(|sample| to_f32(*sample)).sum();
            sum / frame.len() as f32
        })
        .collect()
}

/// De f32 (−1..1) a PCM16, recortando lo que se sale de rango.
fn push_pcm16(samples: &[f32], into: &mut Vec<i16>) {
    for sample in samples {
        into.push((sample * 32_767.0).round().clamp(-32_768.0, 32_767.0) as i16);
    }
}

/// Un trozo en los bytes del contrato: PCM16 **little-endian**.
fn pcm_bytes(samples: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

// ------------------------------------------------------------------- la nota

/// Quién empezó la nota. Es lo que decide qué tira perder el foco: la del botón
/// del chat se graba con la ventana principal delante; la del atajo, con el Dot
/// compacto, y sigue aunque la principal pierda el foco.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// El botón del micro de la ventana principal (`dot_voice_start`).
    Main,
    /// El atajo global mantenido (`hold.rs`), con el Dot compacto delante.
    Shortcut,
}

/// De qué sesión es la nota.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Session {
    /// La sabe quien la pide: el botón del chat manda la del campo.
    Known(String),
    /// La del asistente: se resuelve **dentro de la tarea**, con el micrófono ya
    /// abierto, así el atajo no espera a nadie para empezar a grabar.
    Companion,
}

/// Lo que la página del compacto enseña mientras se graba: cuánto lleva y el
/// nivel de lo último capturado. Del audio, solo este número.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Progress {
    /// Segundos de audio capturados (a 16 kHz).
    pub seconds: u64,
    /// RMS del último bloque, en dBFS (−100..0).
    pub level: Option<f32>,
}

/// Los topes de una nota (`VOICE_UPLOAD_LIMITS` del protocolo), a 16 kHz.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Tope de un trozo (`chunkBytes`): 2 s de PCM16.
    pub chunk_bytes: usize,
    /// Lo más corto que se transcribe (`minSeconds` = 0,5 s).
    pub min_samples: usize,
    /// Lo más largo que se graba (`maxSeconds` = 300 s): al llegar se para sola.
    pub max_samples: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            chunk_bytes: 65_536,
            min_samples: TARGET_SAMPLE_RATE as usize / 2,
            max_samples: TARGET_SAMPLE_RATE as usize * 300,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Finish {
    /// Subir lo que quede y pedir `voice.end`.
    Drain,
    /// Tirarlo y pedir `voice.cancel`.
    Drop,
}

/// Lo que el bucle de subida hace en cada vuelta.
enum Step {
    /// Un trozo listo, ya en muestras de 16 kHz.
    Send(Vec<i16>),
    /// El micrófono llegó al tope: pararlo (lo grabado espera a `stop`).
    Halt,
    /// Hay que terminar.
    Finish(Finish),
    /// Nada que hacer todavía.
    Wait,
}

/// Lo que se comparte entre el micrófono, el bucle de subida y los comandos.
struct Shared {
    /// La cinta: lo grabado y lo que falta por subir, a 16 kHz.
    tape: Mutex<Tape>,
    /// El micrófono, para poder pararlo desde cualquier sitio.
    capture: Mutex<Box<dyn AudioSource>>,
    limits: Limits,
    /// La bandeja: mientras se graba, lo dice.
    listener: Option<Listener>,
}

struct Tape {
    /// 48 kHz → 16 kHz; `None` cuando el micrófono ya va a 16 kHz.
    resampler: Option<VoiceResampler>,
    /// PCM16 a 16 kHz que aún no se ha subido.
    pending: Vec<i16>,
    /// Muestras a 16 kHz capturadas, subidas o no.
    captured: usize,
    /// Hay que terminar: subir el resto (`Drain`) o tirarlo (`Drop`).
    finish: Option<Finish>,
    /// Se llegó al tope de la nota.
    full: bool,
    /// El micrófono ya está parado.
    stopped: bool,
    /// RMS del último bloque capturado, en dBFS. Solo el número: las muestras no
    /// salen de aquí.
    level: Option<f32>,
}

impl Shared {
    /// Añade lo que entrega el micrófono (mono, a su frecuencia).
    fn push(&self, frames: &[f32]) {
        let mut tape = lock(&self.tape);
        if tape.finish.is_some() || tape.full {
            return;
        }
        // El nivel se mide de lo que llega del micrófono, antes de remuestrear:
        // es lo que la barra del compacto enseña.
        if let Some(level) = level_dbfs(frames) {
            tape.level = Some(level);
        }
        let mut resampled = Vec::new();
        let samples: &[f32] = match tape.resampler.as_mut() {
            Some(resampler) => {
                resampler.push(frames, &mut resampled);
                &resampled
            }
            None => frames,
        };
        append_capped(&self.limits, &mut tape, samples);
    }

    /// Para el micrófono (una sola vez) y suelta lo que quede del remuestreo.
    fn stop_capture(&self) {
        {
            let mut tape = lock(&self.tape);
            if tape.stopped {
                return;
            }
            tape.stopped = true;
        }
        lock(&self.capture).stop();
        let mut tail = Vec::new();
        {
            let mut tape = lock(&self.tape);
            if let Some(resampler) = tape.resampler.as_mut() {
                resampler.finish(&mut tail);
            }
            append_capped(&self.limits, &mut tape, &tail);
        }
        if let Some(listener) = &self.listener {
            listener(false);
        }
    }

    /// Pide terminar: el bucle de subida hace el resto.
    fn mark(&self, finish: Finish) {
        lock(&self.tape).finish = Some(finish);
    }

    /// Para el micrófono y tira lo grabado (sin esperar a nada).
    fn discard(&self) {
        self.mark(Finish::Drop);
        self.stop_capture();
        self.release();
    }

    /// Suelta el audio: el daemon ya lo tiene (o ya no vale).
    fn release(&self) {
        let mut tape = lock(&self.tape);
        tape.pending.clear();
        tape.pending.shrink_to_fit();
    }

    fn captured(&self) -> usize {
        lock(&self.tape).captured
    }

    /// Cuánto lleva y qué nivel trae lo último capturado.
    fn progress(&self) -> Progress {
        let tape = lock(&self.tape);
        Progress {
            seconds: (tape.captured / TARGET_SAMPLE_RATE as usize) as u64,
            level: tape.level,
        }
    }

    /// Lo siguiente que hay que hacer, sin soltar el candado mientras se actúa.
    fn step(&self) -> Step {
        let mut tape = lock(&self.tape);
        if tape.finish == Some(Finish::Drop) {
            return Step::Finish(Finish::Drop);
        }
        let draining = tape.finish == Some(Finish::Drain);
        // Un trozo son `chunk_bytes` de bytes: la mitad, en muestras.
        let chunk = (self.limits.chunk_bytes / 2).max(1);
        if tape.pending.len() >= chunk || (draining && !tape.pending.is_empty()) {
            let take = chunk.min(tape.pending.len());
            let samples: Vec<i16> = tape.pending.drain(..take).collect();
            return Step::Send(samples);
        }
        if draining {
            return Step::Finish(Finish::Drain);
        }
        if tape.full {
            // Ya parado: solo queda esperar a que la persona suelte.
            return if tape.stopped { Step::Wait } else { Step::Halt };
        }
        Step::Wait
    }
}

/// Guarda el PCM de 16 kHz en la cinta, sin pasarse del tope de la nota.
fn append_capped(limits: &Limits, tape: &mut Tape, samples: &[f32]) {
    let room = limits.max_samples.saturating_sub(tape.captured);
    let take = samples.len().min(room);
    push_pcm16(&samples[..take], &mut tape.pending);
    tape.captured += take;
    if tape.captured >= limits.max_samples {
        tape.full = true;
    }
}

/// El RMS de un bloque, en dBFS (−100..0). Es lo único que sale de las muestras
/// hacia la interfaz: el número, nunca las muestras.
fn level_dbfs(frames: &[f32]) -> Option<f32> {
    if frames.is_empty() {
        return None;
    }
    let sum: f32 = frames.iter().map(|sample| sample * sample).sum();
    let rms = (sum / frames.len() as f32).sqrt();
    // 1e-5 es el fondo de la escala: −100 dBFS, y de ahí no se baja (log10(0)
    // no existe y un «−inf» no se puede pintar).
    Some((20.0 * rms.max(1e-5).log10()).clamp(MIN_DBFS, 0.0))
}

// ------------------------------------------------------------------ el enlace

/// Lo único que la grabación necesita del enlace: los cuatro métodos de voz y la
/// sesión del asistente. Se implementa para [`LinkHandle`] y, en los tests, para
/// un subidor falso.
pub trait VoiceUploads: Clone + Send + Sync + 'static {
    /// La sesión del asistente (`sessions.open { agent: 'companion' }`): si ya
    /// existe, el daemon devuelve la que hay. Es lo que resuelve el atajo sin
    /// que el lado nativo conozca el DTO.
    fn companion_session(&self) -> impl Future<Output = Result<String, CommandError>> + Send;
    fn voice_begin(
        &self,
        session_id: String,
    ) -> impl Future<Output = Result<Value, CommandError>> + Send;
    fn voice_append(
        &self,
        upload_id: String,
        seq: u64,
        pcm: Vec<u8>,
    ) -> impl Future<Output = Result<Value, CommandError>> + Send;
    fn voice_end(
        &self,
        upload_id: String,
    ) -> impl Future<Output = Result<Value, CommandError>> + Send;
    fn voice_cancel(
        &self,
        upload_id: String,
    ) -> impl Future<Output = Result<Value, CommandError>> + Send;
}

// `impl Future<..> + Send` a mano y no `async fn` en el trait: un `async fn` de
// un trait no promete `Send`, y estas cuatro van en una tarea de tokio. Es el
// mismo motivo por el que no se usa `async fn` en la declaración de arriba.
#[allow(clippy::manual_async_fn)]
impl VoiceUploads for LinkHandle {
    fn companion_session(&self) -> impl Future<Output = Result<String, CommandError>> + Send {
        let action = CallAction::OpenSession {
            cwd: None,
            agent: Some(COMPANION_AGENT.to_string()),
            provider: None,
            model: None,
        };
        async move {
            let opened = self.call(action).await?;
            opened
                .get("session")
                .and_then(|session| session.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| not_sent("The assistant session could not be opened."))
        }
    }

    fn voice_begin(
        &self,
        session_id: String,
    ) -> impl Future<Output = Result<Value, CommandError>> + Send {
        let action = CallAction::VoiceBegin { session_id };
        async move { self.call(action).await }
    }

    fn voice_append(
        &self,
        upload_id: String,
        seq: u64,
        pcm: Vec<u8>,
    ) -> impl Future<Output = Result<Value, CommandError>> + Send {
        let action = CallAction::VoiceAppend {
            upload_id,
            seq,
            pcm,
        };
        async move { self.call(action).await }
    }

    fn voice_end(
        &self,
        upload_id: String,
    ) -> impl Future<Output = Result<Value, CommandError>> + Send {
        let action = CallAction::VoiceEnd { upload_id };
        async move { self.call(action).await }
    }

    fn voice_cancel(
        &self,
        upload_id: String,
    ) -> impl Future<Output = Result<Value, CommandError>> + Send {
        let action = CallAction::VoiceCancel { upload_id };
        async move { self.call(action).await }
    }
}

// --------------------------------------------------------------- la grabación

/// La grabación en curso: la cinta y el bucle que la sube.
struct Active {
    shared: Arc<Shared>,
    pump: tokio::task::JoinHandle<Result<Value, CommandError>>,
    /// Quién la empezó: decide qué tira perder el foco.
    origin: Origin,
}

/// La grabación de una nota (`DotState`). Una a la vez.
pub struct VoiceRecorder<U: VoiceUploads> {
    uploads: U,
    logger: Logger,
    limits: Limits,
    listener: Option<Listener>,
    make_source: SourceFactory,
    active: Mutex<Option<Active>>,
    /// Hay un `start` abriendo el micrófono. Reserva el sitio **sin tener el
    /// candado de `active`**: abrir el micro tarda y avisar a la bandeja necesita
    /// el hilo principal, que puede estar esperando ese candado (al perder el foco
    /// la ventana principal llama a `abort_from`). Tenerlo cogido aquí colgó Dot.
    starting: AtomicBool,
}

impl<U: VoiceUploads> VoiceRecorder<U> {
    /// El micrófono de verdad y los topes del protocolo.
    pub fn new(uploads: U, logger: Logger, listener: Option<Listener>) -> Self {
        Self {
            uploads,
            logger,
            limits: Limits::default(),
            listener,
            make_source: Arc::new(|| {
                CpalSource::open().map(|source| Box::new(source) as Box<dyn AudioSource>)
            }),
            active: Mutex::new(None),
            starting: AtomicBool::new(false),
        }
    }

    /// Otro micrófono (los tests usan una fuente falsa).
    pub fn with_source(mut self, make_source: SourceFactory) -> Self {
        self.make_source = make_source;
        self
    }

    /// Otros topes (los tests no graban 300 s).
    pub fn with_limits(mut self, limits: Limits) -> Self {
        self.limits = limits;
        self
    }

    pub fn is_recording(&self) -> bool {
        self.starting.load(Ordering::SeqCst) || lock(&self.active).is_some()
    }

    /// Quién empezó la nota en curso, si hay alguna.
    pub fn origin(&self) -> Option<Origin> {
        lock(&self.active).as_ref().map(|active| active.origin)
    }

    /// Lo que la página del compacto enseña mientras se graba: segundos y nivel.
    /// `None` si no hay nota (ni grabando ni esperando a que se la lleven).
    pub fn progress(&self) -> Option<Progress> {
        let slot = lock(&self.active);
        let active = slot.as_ref()?;
        Some(active.shared.progress())
    }

    /// Empieza una nota de esa sesión, para el botón del chat: **abre el
    /// micrófono ya** y pide `voice.begin` a la vez. Lo grabado antes de tener el
    /// `uploadId` no se pierde: espera en memoria y se sube primero.
    pub async fn start(&self, session_id: &str) -> Result<(), CommandError> {
        self.start_with(Session::Known(session_id.to_string()), Origin::Main)
            .await
    }

    /// Empieza la nota del **atajo**: la misma prisa por abrir el micrófono, pero
    /// la sesión es la del asistente y se resuelve dentro de la tarea, ya con el
    /// micrófono abierto. Si falla, el error llega por `stop()` como los demás.
    pub async fn start_companion(&self) -> Result<(), CommandError> {
        self.start_with(Session::Companion, Origin::Shortcut).await
    }

    async fn start_with(&self, session: Session, origin: Origin) -> Result<(), CommandError> {
        // Una nota a la vez: se reserva el sitio con `starting` y **sin** tener el
        // candado de `active` mientras se abre el micrófono (ver `starting`).
        let busy = || {
            CommandError::new(
                CommandErrorKind::Invalid,
                "A note is already being recorded.",
            )
        };
        if lock(&self.active).is_some() {
            return Err(busy());
        }
        if self
            .starting
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(busy());
        }
        let started = self.open_note(session, origin);
        // `active` se apunta antes de soltar la reserva: entre las dos no cabe otro `start`.
        let result = started.map(|active| *lock(&self.active) = Some(active));
        self.starting.store(false, Ordering::SeqCst);
        result
    }

    /// Abre el micrófono y lanza el bucle de subida. Sin ningún candado cogido.
    fn open_note(&self, session: Session, origin: Origin) -> Result<Active, CommandError> {
        let source = (self.make_source)().map_err(not_sent)?;
        let rate = source.sample_rate();
        // El micrófono manda; el resto de frecuencias no están medidas.
        if rate != CAPTURE_SAMPLE_RATE && rate != TARGET_SAMPLE_RATE {
            return Err(not_sent(format!(
                "Microphone at {rate} Hz is not supported."
            )));
        }
        let shared = Arc::new(Shared {
            tape: Mutex::new(Tape {
                resampler: (rate == CAPTURE_SAMPLE_RATE).then(VoiceResampler::new),
                pending: Vec::new(),
                captured: 0,
                finish: None,
                full: false,
                stopped: false,
                level: None,
            }),
            capture: Mutex::new(source),
            limits: self.limits,
            listener: self.listener.clone(),
        });
        // El micrófono, en el acto: abrirlo tarda y no se puede perder el principio.
        {
            let sink = {
                let shared = shared.clone();
                Box::new(move |frames: &[f32]| shared.push(frames)) as FrameSink
            };
            lock(&shared.capture).start(sink).map_err(not_sent)?;
        }
        if let Some(listener) = &shared.listener {
            listener(true);
        }
        self.logger.info("voice: recording");
        // `voice.begin` (y, en el atajo, la sesión del asistente) a la vez que el
        // micrófono ya graba.
        let pump = tokio::spawn(run(
            self.uploads.clone(),
            shared.clone(),
            session,
            self.logger.clone(),
        ));
        Ok(Active {
            shared,
            pump,
            origin,
        })
    }

    /// Termina la nota: para el micrófono, sube el resto y pide `voice.end`.
    /// Devuelve lo que contesta el daemon **sin interpretar**. Menos de 0,5 s de
    /// audio no se transcribe: se tira con `voice.cancel` y es un error.
    pub async fn stop(&self) -> Result<Value, CommandError> {
        let Some(active) = self.take() else {
            return Err(nothing_recording());
        };
        active.shared.stop_capture();
        active.shared.mark(Finish::Drain);
        join(active.pump).await
    }

    /// Tira la nota: para el micrófono y pide `voice.cancel`.
    pub async fn cancel(&self) -> Result<(), CommandError> {
        let Some(active) = self.take() else {
            return Err(nothing_recording());
        };
        active.shared.discard();
        // Si `begin` aún no ha contestado, el aviso lo manda el bucle cuando
        // llegue: no se hace esperar al webview por eso (la tarea sigue sola).
        let _ = tokio::time::timeout(CANCEL_WAIT, active.pump).await;
        Ok(())
    }

    /// Para el micrófono en el acto y tira lo grabado, sin esperar: cerrar Dot.
    /// El `voice.cancel` sale cuando puede.
    pub fn abort(&self) {
        let Some(active) = self.take() else {
            return;
        };
        active.shared.discard();
        drop(active.pump);
    }

    /// Lo mismo, pero solo si la nota la empezó `origin`: perder el foco de la
    /// ventana principal tira las suyas y **no** la del atajo, que se graba con
    /// el Dot compacto delante.
    pub fn abort_from(&self, origin: Origin) {
        let Some(active) = self.take_if(origin) else {
            return;
        };
        active.shared.discard();
        drop(active.pump);
    }

    fn take(&self) -> Option<Active> {
        lock(&self.active).take()
    }

    fn take_if(&self, origin: Origin) -> Option<Active> {
        let mut slot = lock(&self.active);
        if slot.as_ref().map(|active| active.origin) != Some(origin) {
            return None;
        }
        slot.take()
    }
}

async fn join(
    pump: tokio::task::JoinHandle<Result<Value, CommandError>>,
) -> Result<Value, CommandError> {
    pump.await.unwrap_or_else(|_| {
        Err(not_sent(
            "The note was interrupted before it could be transcribed.",
        ))
    })
}

/// El bucle de una nota: resuelve la sesión (si hay que resolverla), espera el
/// `uploadId`, sube el audio troceado y, al terminar, pide `voice.end` (o
/// `voice.cancel`). Lo que contesta el daemon vuelve sin interpretar.
async fn run<U: VoiceUploads>(
    uploads: U,
    shared: Arc<Shared>,
    session: Session,
    logger: Logger,
) -> Result<Value, CommandError> {
    let session_id = match session {
        Session::Known(session_id) => session_id,
        // El atajo no sabe de qué sesión es la nota: se pregunta aquí, con el
        // micrófono ya grabando, y lo grabado mientras tanto no se pierde.
        Session::Companion => match uploads.companion_session().await {
            Ok(session_id) => session_id,
            Err(error) => {
                // Igual que si `voice.begin` falla: sin sesión no hay a dónde
                // mandar el audio, así que se tira.
                shared.discard();
                logger.warn("voice: the assistant session did not open");
                return Err(error);
            }
        },
    };
    let begun = match uploads.voice_begin(session_id).await {
        Ok(begun) => begun,
        Err(error) => {
            // Se para el micrófono y se tira el audio: no hay a dónde subirlo.
            shared.discard();
            logger.warn("voice: the daemon did not open the note");
            return Err(error);
        }
    };
    let Some(upload_id) = begun
        .get("uploadId")
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        shared.discard();
        logger.warn("voice: the daemon opened the note without an id");
        return Err(not_sent("The daemon did not open the note."));
    };
    logger.info("voice: note opened");
    let mut seq = 0u64;
    loop {
        match shared.step() {
            Step::Send(samples) => {
                match uploads
                    .voice_append(upload_id.clone(), seq, pcm_bytes(&samples))
                    .await
                {
                    Ok(_) => seq += 1,
                    Err(error) => {
                        shared.discard();
                        logger.warn("voice: a chunk was rejected; the note is dropped");
                        return Err(error);
                    }
                }
            }
            Step::Halt => {
                shared.stop_capture();
                logger.info("voice: the note reached its limit");
                tokio::time::sleep(PUMP_INTERVAL).await;
            }
            Step::Wait => tokio::time::sleep(PUMP_INTERVAL).await,
            Step::Finish(Finish::Drop) => {
                shared.discard();
                if uploads.voice_cancel(upload_id).await.is_err() {
                    logger.warn("voice: the daemon did not drop the note");
                }
                logger.info("voice: the note was cancelled");
                return Ok(Value::Null);
            }
            Step::Finish(Finish::Drain) => {
                return finish(&uploads, &shared, upload_id, &logger).await;
            }
        }
    }
}

/// Cierra la subida: `voice.end`, o `voice.cancel` si es un toque sin querer.
async fn finish<U: VoiceUploads>(
    uploads: &U,
    shared: &Shared,
    upload_id: String,
    logger: &Logger,
) -> Result<Value, CommandError> {
    let captured = shared.captured();
    // El audio ya está (o ya no vale) en este punto: se suelta aquí.
    shared.release();
    if captured < shared.limits.min_samples {
        if uploads.voice_cancel(upload_id).await.is_err() {
            logger.warn("voice: the daemon did not drop the short note");
        }
        logger.info("voice: too short; the note was dropped");
        return Err(CommandError::new(
            CommandErrorKind::Invalid,
            "The recording is too short.",
        ));
    }
    let ended = uploads.voice_end(upload_id).await;
    match &ended {
        Ok(_) => logger.info("voice: note sent"),
        Err(_) => logger.warn("voice: the daemon could not transcribe the note"),
    }
    ended
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::AtomicUsize;
    use tokio::sync::Notify;

    // ------------------------------------------------------- fuente de pruebas

    struct FakeState {
        rate: u32,
        sink: Mutex<Option<FrameSink>>,
        stops: AtomicUsize,
    }

    /// El micrófono de los tests: entrega lo que le diga la prueba.
    #[derive(Clone)]
    struct FakeSource {
        state: Arc<FakeState>,
    }

    impl FakeSource {
        fn new(rate: u32) -> Self {
            Self {
                state: Arc::new(FakeState {
                    rate,
                    sink: Mutex::new(None),
                    stops: AtomicUsize::new(0),
                }),
            }
        }

        /// Simula lo que entrega el micrófono.
        fn feed(&self, frames: &[f32]) {
            let mut sink = lock(&self.state.sink);
            if let Some(sink) = sink.as_mut() {
                sink(frames);
            }
        }

        fn stops(&self) -> usize {
            self.state.stops.load(Ordering::SeqCst)
        }

        fn factory(&self) -> SourceFactory {
            let state = self.state.clone();
            Arc::new(move || {
                Ok(Box::new(FakeSource {
                    state: state.clone(),
                }) as Box<dyn AudioSource>)
            })
        }
    }

    impl AudioSource for FakeSource {
        fn sample_rate(&self) -> u32 {
            self.state.rate
        }

        fn start(&mut self, sink: FrameSink) -> Result<(), String> {
            *lock(&self.state.sink) = Some(sink);
            Ok(())
        }

        fn stop(&mut self) {
            self.state.stops.fetch_add(1, Ordering::SeqCst);
        }
    }

    // ---------------------------------------------------- subidor de pruebas

    #[derive(Default)]
    struct Seen {
        /// Lo que se pidió, en orden: `session`, `begin`, `append`, `end` o `cancel`.
        order: Vec<&'static str>,
        sessions: Vec<String>,
        /// Cada `voice.append`, en orden: su `seq` y sus bytes.
        appends: Vec<(u64, Vec<u8>)>,
        ends: usize,
        cancels: usize,
    }

    /// El enlace de los tests: apunta lo que le piden.
    #[derive(Clone)]
    struct FakeUploads {
        seen: Arc<Mutex<Seen>>,
        /// Si está, `voice.begin` espera a que la prueba le dé paso.
        gate: Option<Arc<Notify>>,
        /// Si está, la sesión del asistente espera a que la prueba le dé paso.
        session_gate: Option<Arc<Notify>>,
        /// Si es verdad, el primer `voice.append` falla.
        fail_append: bool,
        /// Lo que contesta `voice.end`.
        transcript: Value,
    }

    impl FakeUploads {
        fn new() -> Self {
            Self {
                seen: Arc::new(Mutex::new(Seen::default())),
                gate: None,
                session_gate: None,
                fail_append: false,
                transcript: json!({
                    "transcript": { "text": "hola", "durationSec": 2.0, "capped": false, "device": "cpu" }
                }),
            }
        }

        /// `voice.begin` no contesta hasta que la prueba llame `gate.notify_one()`.
        fn gated() -> (Self, Arc<Notify>) {
            let gate = Arc::new(Notify::new());
            (
                Self {
                    gate: Some(gate.clone()),
                    ..Self::new()
                },
                gate,
            )
        }

        /// La sesión del asistente no se resuelve hasta que la prueba le dé paso.
        fn companion_gated() -> (Self, Arc<Notify>) {
            let gate = Arc::new(Notify::new());
            (
                Self {
                    session_gate: Some(gate.clone()),
                    ..Self::new()
                },
                gate,
            )
        }

        fn failing() -> Self {
            Self {
                fail_append: true,
                ..Self::new()
            }
        }

        fn seen(&self) -> MutexGuard<'_, Seen> {
            lock(&self.seen)
        }
    }

    #[allow(clippy::manual_async_fn)]
    impl VoiceUploads for FakeUploads {
        fn companion_session(&self) -> impl Future<Output = Result<String, CommandError>> + Send {
            let gate = self.session_gate.clone();
            let seen = self.seen.clone();
            async move {
                if let Some(gate) = gate {
                    gate.notified().await;
                }
                lock(&seen).order.push("session");
                Ok("ses_companion".to_string())
            }
        }

        fn voice_begin(
            &self,
            session_id: String,
        ) -> impl Future<Output = Result<Value, CommandError>> + Send {
            let gate = self.gate.clone();
            let seen = self.seen.clone();
            async move {
                if let Some(gate) = gate {
                    gate.notified().await;
                }
                let mut seen = lock(&seen);
                seen.order.push("begin");
                seen.sessions.push(session_id);
                Ok(json!({
                    "uploadId": "upl_1",
                    "sampleRate": TARGET_SAMPLE_RATE,
                    "maxSeconds": 300,
                    "chunkBytes": 65_536
                }))
            }
        }

        fn voice_append(
            &self,
            _upload_id: String,
            seq: u64,
            pcm: Vec<u8>,
        ) -> impl Future<Output = Result<Value, CommandError>> + Send {
            let fail = self.fail_append;
            let seen = self.seen.clone();
            async move {
                if fail {
                    return Err(CommandError::new(CommandErrorKind::Rejected, "voice-seq"));
                }
                let mut seen = lock(&seen);
                seen.order.push("append");
                seen.appends.push((seq, pcm));
                Ok(json!({ "seconds": 0.0 }))
            }
        }

        fn voice_end(
            &self,
            _upload_id: String,
        ) -> impl Future<Output = Result<Value, CommandError>> + Send {
            let seen = self.seen.clone();
            let transcript = self.transcript.clone();
            async move {
                let mut seen = lock(&seen);
                seen.order.push("end");
                seen.ends += 1;
                Ok(transcript)
            }
        }

        fn voice_cancel(
            &self,
            _upload_id: String,
        ) -> impl Future<Output = Result<Value, CommandError>> + Send {
            let seen = self.seen.clone();
            async move {
                let mut seen = lock(&seen);
                seen.order.push("cancel");
                seen.cancels += 1;
                Ok(json!({}))
            }
        }
    }

    // -------------------------------------------------------------- utilidades

    fn setup(rate: u32, limits: Limits) -> (VoiceRecorder<FakeUploads>, FakeSource, FakeUploads) {
        let source = FakeSource::new(rate);
        let uploads = FakeUploads::new();
        let recorder = VoiceRecorder::new(uploads.clone(), Logger::none(), None)
            .with_source(source.factory())
            .with_limits(limits);
        (recorder, source, uploads)
    }

    /// Un tono de `hz` a `rate`, de `len` muestras.
    fn tone(hz: f64, rate: u32, len: usize) -> Vec<f32> {
        (0..len)
            .map(|index| {
                (2.0 * std::f64::consts::PI * hz * index as f64 / rate as f64).sin() as f32
            })
            .collect()
    }

    /// Un pico de amplitud lejos de los bordes (donde la ventana se corta).
    fn peak(samples: &[f32]) -> f32 {
        let margin = HALF + 1;
        samples[margin..samples.len() - margin]
            .iter()
            .fold(0.0f32, |max, sample| max.max(sample.abs()))
    }

    /// El filtro tal cual, sin streaming, como `resample.ts`: la referencia.
    fn reference(input: &[f32], coefficients: &[f64; TAPS]) -> Vec<f32> {
        let out_len = input.len() / FACTOR;
        (0..out_len)
            .map(|m| {
                let center = (m * FACTOR) as i64;
                let mut acc = 0.0f64;
                for (k, coefficient) in coefficients.iter().enumerate() {
                    let index = center - HALF as i64 + k as i64;
                    if index < 0 || index >= input.len() as i64 {
                        continue;
                    }
                    acc += coefficient * input[index as usize] as f64;
                }
                acc as f32
            })
            .collect()
    }

    // --------------------------------------------------------- el remuestreo

    #[test]
    fn el_filtro_deja_pasar_la_voz_y_corta_lo_que_se_pliega() {
        let mut resampler = VoiceResampler::new();
        let mut out = Vec::new();
        // 1 kHz: pasa entero (ganancia ≈ 1).
        let speech = tone(1_000.0, CAPTURE_SAMPLE_RATE, 24_000);
        resampler.push(&speech, &mut out);
        resampler.finish(&mut out);
        assert_eq!(out.len(), 8_000, "la salida es un tercio de la entrada");
        let gain = peak(&out);
        assert!((gain - 1.0).abs() < 0.02, "ganancia {gain}");
        // 10 kHz, que sin filtrar caería en 6 kHz: por debajo de −40 dB.
        let mut resampler = VoiceResampler::new();
        let mut out = Vec::new();
        let aliased = tone(10_000.0, CAPTURE_SAMPLE_RATE, 24_000);
        resampler.push(&aliased, &mut out);
        resampler.finish(&mut out);
        let leak = peak(&out);
        assert!(leak < 0.01, "10 kHz se cuela a {leak} (−40 dB = 0,01)");
    }

    #[test]
    fn en_trozos_da_lo_mismo_que_de_una_vez() {
        let coefficients = design_low_pass();
        let input = tone(440.0, CAPTURE_SAMPLE_RATE, 20_000);
        let whole = reference(&input, &coefficients);
        // De una vez.
        let mut resampler = VoiceResampler::new();
        let mut once = Vec::new();
        resampler.push(&input, &mut once);
        resampler.finish(&mut once);
        assert_eq!(once, whole);
        // A trozos de un tamaño que no es múltiplo de 3.
        let mut resampler = VoiceResampler::new();
        let mut chunked = Vec::new();
        for chunk in input.chunks(173) {
            resampler.push(chunk, &mut chunked);
        }
        resampler.finish(&mut chunked);
        assert_eq!(chunked, whole);
        // Y con un trozo de cada vez.
        let mut resampler = VoiceResampler::new();
        let mut one_by_one = Vec::new();
        for sample in &input {
            resampler.push(std::slice::from_ref(sample), &mut one_by_one);
        }
        resampler.finish(&mut one_by_one);
        assert_eq!(one_by_one, whole);
    }

    #[test]
    fn la_salida_no_lleva_retardo_de_grupo() {
        // Dos impulsos separados: cada uno tiene que salir en su instante (3m),
        // no desplazado por el centro del filtro.
        let mut input = vec![0.0f32; 3_000];
        input[1_500] = 1.0;
        let mut resampler = VoiceResampler::new();
        let mut out = Vec::new();
        resampler.push(&input, &mut out);
        resampler.finish(&mut out);
        let loudest = out
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.abs().partial_cmp(&b.1.abs()).unwrap())
            .map(|(index, _)| index)
            .unwrap();
        assert_eq!(loudest, 500, "el pico sale en el instante 3m");
    }

    // --------------------------------------------------------------- la captura

    #[test]
    fn los_canales_se_mezclan_a_mono() {
        let stereo = mono_i16(&[1_000, 3_000, -1_000, 1_000], 2);
        assert!((stereo[0] - 2_000.0 / 32_768.0).abs() < 1e-6, "{stereo:?}");
        assert!(stereo[1].abs() < 1e-6, "{stereo:?}");
        assert_eq!(
            mono_i16(&[1_000, 2_000], 1),
            vec![1_000.0 / 32_768.0, 2_000.0 / 32_768.0]
        );
        let unsigned = mono_u16(&[32_768, 65_535], 1);
        assert!(unsigned[0].abs() < 1e-6, "{unsigned:?}");
        assert!((unsigned[1] - 0.99997).abs() < 1e-3, "{unsigned:?}");
        assert_eq!(mono_f32(&[0.5, -0.5], 2), vec![0.0]);
    }

    #[test]
    fn el_pcm16_recorta_y_va_en_little_endian() {
        let mut samples = Vec::new();
        push_pcm16(&[0.0, 1.0, -1.0, 2.0, -2.0], &mut samples);
        assert_eq!(samples, vec![0, 32_767, -32_767, 32_767, -32_768]);
        assert_eq!(pcm_bytes(&[1, -2]), vec![1, 0, 254, 255]);
    }

    #[tokio::test]
    async fn un_micro_a_otra_frecuencia_no_graba_nada() {
        let (recorder, _source, uploads) = setup(44_100, Limits::default());
        let error = recorder.start("ses_1").await.unwrap_err();
        assert_eq!(
            error.message, "Microphone at 44100 Hz is not supported.",
            "el error dice la frecuencia"
        );
        assert!(!recorder.is_recording());
        assert!(
            uploads.seen().sessions.is_empty(),
            "no se pidió nada al daemon"
        );
    }

    #[tokio::test]
    async fn si_el_micro_no_abre_se_dice() {
        let uploads = FakeUploads::new();
        let recorder = VoiceRecorder::new(uploads.clone(), Logger::none(), None)
            .with_source(Arc::new(|| Err("No microphone available.".to_string())));
        let error = recorder.start("ses_1").await.unwrap_err();
        assert_eq!(error.message, "No microphone available.");
        assert!(uploads.seen().sessions.is_empty());
    }

    // --------------------------------------------------------------- la subida

    #[tokio::test]
    async fn sube_en_trozos_de_64_kib_con_seq_consecutivo() {
        let (recorder, source, uploads) = setup(TARGET_SAMPLE_RATE, Limits::default());
        recorder.start("ses_1").await.unwrap();
        // 5 s a 16 kHz: 80 000 muestras, que en PCM16 son 160 000 bytes.
        let audio = tone(440.0, TARGET_SAMPLE_RATE, 80_000);
        for block in audio.chunks(1_000) {
            source.feed(block);
        }
        let transcript = recorder.stop().await.unwrap();
        assert_eq!(transcript["transcript"]["text"], json!("hola"));
        let seen = uploads.seen();
        assert_eq!(seen.sessions, vec!["ses_1".to_string()]);
        assert_eq!(seen.ends, 1);
        assert_eq!(seen.cancels, 0);
        let sizes: Vec<usize> = seen.appends.iter().map(|(_, pcm)| pcm.len()).collect();
        assert_eq!(sizes, vec![65_536, 65_536, 160_000 - 2 * 65_536]);
        let seqs: Vec<u64> = seen.appends.iter().map(|(seq, _)| *seq).collect();
        assert_eq!(seqs, vec![0, 1, 2]);
        // Todo lo grabado llegó, en orden y en PCM16.
        let mut expected = Vec::new();
        push_pcm16(&audio, &mut expected);
        let sent: Vec<u8> = seen
            .appends
            .iter()
            .flat_map(|(_, pcm)| pcm.clone())
            .collect();
        assert_eq!(sent, pcm_bytes(&expected));
    }

    #[tokio::test]
    async fn lo_grabado_antes_del_upload_id_llega_entero_y_primero() {
        let source = FakeSource::new(TARGET_SAMPLE_RATE);
        let (uploads, gate) = FakeUploads::gated();
        let recorder = VoiceRecorder::new(uploads.clone(), Logger::none(), None)
            .with_source(source.factory())
            .with_limits(Limits::default());
        recorder.start("ses_1").await.unwrap();
        // Un segundo antes de que el daemon conteste `begin`...
        let early = tone(300.0, TARGET_SAMPLE_RATE, 16_000);
        source.feed(&early);
        gate.notify_one();
        // ...y otro después.
        let late = tone(900.0, TARGET_SAMPLE_RATE, 16_000);
        source.feed(&late);
        recorder.stop().await.unwrap();
        let seen = uploads.seen();
        assert_eq!(seen.appends.len(), 1, "2 s caben en un solo trozo");
        let mut expected = Vec::new();
        push_pcm16(&early, &mut expected);
        push_pcm16(&late, &mut expected);
        assert_eq!(seen.appends[0].1, pcm_bytes(&expected));
        assert_eq!(seen.appends[0].0, 0);
        assert_eq!(seen.ends, 1);
    }

    #[tokio::test]
    async fn una_nota_a_48_khz_baja_a_16_khz_antes_de_subirse() {
        let (recorder, source, uploads) = setup(CAPTURE_SAMPLE_RATE, Limits::default());
        recorder.start("ses_1").await.unwrap();
        let audio = tone(440.0, CAPTURE_SAMPLE_RATE, 16_000 * 3);
        source.feed(&audio);
        recorder.stop().await.unwrap();
        let seen = uploads.seen();
        let sent: usize = seen.appends.iter().map(|(_, pcm)| pcm.len()).sum();
        // 3 s de entrada a 48 kHz son 1 s a 16 kHz: 2 bytes por muestra.
        assert_eq!(sent, 16_000 * 2);
    }

    #[tokio::test]
    async fn menos_de_medio_segundo_se_tira_sin_pedir_el_fin() {
        let (recorder, source, uploads) = setup(TARGET_SAMPLE_RATE, Limits::default());
        recorder.start("ses_1").await.unwrap();
        source.feed(&tone(440.0, TARGET_SAMPLE_RATE, 4_000)); // 0,25 s
        let error = recorder.stop().await.unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Invalid);
        assert!(error.message.contains("too short"), "{}", error.message);
        let seen = uploads.seen();
        assert_eq!(seen.ends, 0, "no se pide `voice.end`");
        assert_eq!(seen.cancels, 1);
    }

    #[tokio::test]
    async fn al_llegar_al_tope_se_para_sola_y_lo_grabado_no_se_pierde() {
        let limits = Limits {
            max_samples: 16_000, // 1 s, para no grabar cinco minutos
            ..Limits::default()
        };
        let (recorder, source, uploads) = setup(TARGET_SAMPLE_RATE, limits);
        recorder.start("ses_1").await.unwrap();
        source.feed(&tone(440.0, TARGET_SAMPLE_RATE, 16_000));
        // El bucle tiene que ver el tope y parar el micrófono.
        tokio::time::sleep(PUMP_INTERVAL * 5).await;
        assert_eq!(source.stops(), 1, "el micrófono se paró solo");
        // Lo que llegue después ya no cuenta.
        source.feed(&tone(440.0, TARGET_SAMPLE_RATE, 16_000));
        let transcript = recorder.stop().await.unwrap();
        assert_eq!(transcript["transcript"]["device"], json!("cpu"));
        let seen = uploads.seen();
        assert_eq!(seen.ends, 1);
        let sent: usize = seen.appends.iter().map(|(_, pcm)| pcm.len()).sum();
        assert_eq!(sent, 16_000 * 2, "se transcribe el tope entero, no más");
    }

    #[tokio::test]
    async fn cancelar_en_cada_estado() {
        // Sin nada grabando: no hay nota que tirar.
        let (recorder, _source, uploads) = setup(TARGET_SAMPLE_RATE, Limits::default());
        assert!(recorder.cancel().await.is_err());
        // Grabando, sin audio todavía.
        recorder.start("ses_1").await.unwrap();
        assert!(recorder.is_recording());
        recorder.cancel().await.unwrap();
        assert!(!recorder.is_recording());
        {
            let seen = uploads.seen();
            assert_eq!(seen.cancels, 1);
            assert_eq!(seen.ends, 0);
            assert!(seen.appends.is_empty());
        }
        // Y después de parar, ya no hay nada.
        assert!(recorder.stop().await.is_err());
        assert!(recorder.cancel().await.is_err());

        // Grabando y con `begin` aún en el aire: se tira igual y no se sube nada.
        let source = FakeSource::new(TARGET_SAMPLE_RATE);
        let (uploads, gate) = FakeUploads::gated();
        let recorder = VoiceRecorder::new(uploads.clone(), Logger::none(), None)
            .with_source(source.factory())
            .with_limits(Limits::default());
        recorder.start("ses_1").await.unwrap();
        source.feed(&tone(440.0, TARGET_SAMPLE_RATE, 16_000));
        gate.notify_one();
        recorder.cancel().await.unwrap();
        let seen = uploads.seen();
        assert_eq!(seen.cancels, 1);
        assert_eq!(seen.ends, 0);
    }

    #[tokio::test]
    async fn si_un_trozo_falla_se_para_y_la_nota_da_ese_error() {
        let source = FakeSource::new(TARGET_SAMPLE_RATE);
        let uploads = FakeUploads::failing();
        let recorder = VoiceRecorder::new(uploads.clone(), Logger::none(), None)
            .with_source(source.factory())
            .with_limits(Limits::default());
        recorder.start("ses_1").await.unwrap();
        source.feed(&tone(440.0, TARGET_SAMPLE_RATE, 40_000)); // 2,5 s: hay trozo
        let error = recorder.stop().await.unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert_eq!(source.stops(), 1, "el micrófono se paró");
        assert_eq!(uploads.seen().ends, 0);
        assert!(!recorder.is_recording());
    }

    #[tokio::test]
    async fn si_begin_falla_no_se_graba_nada() {
        let source = FakeSource::new(TARGET_SAMPLE_RATE);
        #[derive(Clone)]
        struct NoDaemon;
        #[allow(clippy::manual_async_fn)]
        impl VoiceUploads for NoDaemon {
            fn companion_session(
                &self,
            ) -> impl Future<Output = Result<String, CommandError>> + Send {
                async { Ok("ses_1".to_string()) }
            }
            fn voice_begin(
                &self,
                _session_id: String,
            ) -> impl Future<Output = Result<Value, CommandError>> + Send {
                async {
                    Err(CommandError::new(
                        CommandErrorKind::Rejected,
                        "voice-disabled",
                    ))
                }
            }
            fn voice_append(
                &self,
                _upload_id: String,
                _seq: u64,
                _pcm: Vec<u8>,
            ) -> impl Future<Output = Result<Value, CommandError>> + Send {
                async { Ok(Value::Null) }
            }
            fn voice_end(
                &self,
                _upload_id: String,
            ) -> impl Future<Output = Result<Value, CommandError>> + Send {
                async { Ok(Value::Null) }
            }
            fn voice_cancel(
                &self,
                _upload_id: String,
            ) -> impl Future<Output = Result<Value, CommandError>> + Send {
                async { Ok(Value::Null) }
            }
        }
        let recorder = VoiceRecorder::new(NoDaemon, Logger::none(), None)
            .with_source(source.factory())
            .with_limits(Limits::default());
        recorder.start("ses_1").await.unwrap();
        source.feed(&tone(440.0, TARGET_SAMPLE_RATE, 16_000));
        let error = recorder.stop().await.unwrap_err();
        assert_eq!(error.message, "voice-disabled");
        assert_eq!(source.stops(), 1, "el micrófono se paró al fallar `begin`");
    }

    #[tokio::test]
    async fn una_nota_a_la_vez() {
        let (recorder, _source, _uploads) = setup(TARGET_SAMPLE_RATE, Limits::default());
        recorder.start("ses_1").await.unwrap();
        let error = recorder.start("ses_1").await.unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Invalid);
        recorder.cancel().await.unwrap();
    }

    // ------------------------------------------------------------- el atajo

    #[tokio::test]
    async fn la_nota_del_atajo_resuelve_la_sesion_dentro_de_la_tarea() {
        let source = FakeSource::new(TARGET_SAMPLE_RATE);
        let (uploads, session_gate) = FakeUploads::companion_gated();
        let recorder = VoiceRecorder::new(uploads.clone(), Logger::none(), None)
            .with_source(source.factory())
            .with_limits(Limits::default());
        recorder.start_companion().await.unwrap();
        assert_eq!(recorder.origin(), Some(Origin::Shortcut));
        // El micrófono ya graba aunque la sesión aún no se sepa.
        let early = tone(300.0, TARGET_SAMPLE_RATE, 16_000);
        source.feed(&early);
        session_gate.notify_one();
        let late = tone(900.0, TARGET_SAMPLE_RATE, 16_000);
        source.feed(&late);
        recorder.stop().await.unwrap();
        let seen = uploads.seen();
        // Primero la sesión del asistente, y `voice.begin` con la que contestó.
        assert_eq!(seen.order[..2], ["session", "begin"][..]);
        assert_eq!(seen.sessions, vec!["ses_companion".to_string()]);
        // Y lo grabado antes de saberla llega entero y primero.
        let mut expected = Vec::new();
        push_pcm16(&early, &mut expected);
        push_pcm16(&late, &mut expected);
        let sent: Vec<u8> = seen
            .appends
            .iter()
            .flat_map(|(_, pcm)| pcm.clone())
            .collect();
        assert_eq!(sent, pcm_bytes(&expected));
        assert_eq!(seen.order.last().copied(), Some("end"));
    }

    #[tokio::test]
    async fn el_boton_del_chat_no_pide_la_sesion_del_asistente() {
        let (recorder, source, uploads) = setup(TARGET_SAMPLE_RATE, Limits::default());
        recorder.start("ses_1").await.unwrap();
        assert_eq!(recorder.origin(), Some(Origin::Main));
        source.feed(&tone(440.0, TARGET_SAMPLE_RATE, 16_000));
        recorder.stop().await.unwrap();
        let seen = uploads.seen();
        assert_eq!(seen.order.first(), Some(&"begin"));
        assert!(!seen.order.contains(&"session"));
    }

    #[tokio::test]
    async fn si_la_sesion_del_asistente_no_abre_se_tira_y_el_error_llega_al_parar() {
        let source = FakeSource::new(TARGET_SAMPLE_RATE);
        #[derive(Clone)]
        struct NoSession;
        #[allow(clippy::manual_async_fn)]
        impl VoiceUploads for NoSession {
            fn companion_session(
                &self,
            ) -> impl Future<Output = Result<String, CommandError>> + Send {
                async {
                    Err(CommandError::new(
                        CommandErrorKind::Rejected,
                        "no-companion",
                    ))
                }
            }
            fn voice_begin(
                &self,
                _s: String,
            ) -> impl Future<Output = Result<Value, CommandError>> + Send {
                async { Ok(Value::Null) }
            }
            fn voice_append(
                &self,
                _u: String,
                _q: u64,
                _p: Vec<u8>,
            ) -> impl Future<Output = Result<Value, CommandError>> + Send {
                async { Ok(Value::Null) }
            }
            fn voice_end(
                &self,
                _u: String,
            ) -> impl Future<Output = Result<Value, CommandError>> + Send {
                async { Ok(Value::Null) }
            }
            fn voice_cancel(
                &self,
                _u: String,
            ) -> impl Future<Output = Result<Value, CommandError>> + Send {
                async { Ok(Value::Null) }
            }
        }
        let recorder = VoiceRecorder::new(NoSession, Logger::none(), None)
            .with_source(source.factory())
            .with_limits(Limits::default());
        recorder.start_companion().await.unwrap();
        source.feed(&tone(440.0, TARGET_SAMPLE_RATE, 16_000));
        let error = recorder.stop().await.unwrap_err();
        assert_eq!(error.message, "no-companion");
        assert_eq!(source.stops(), 1, "el micrófono se paró");
        assert!(!recorder.is_recording());
    }

    #[tokio::test]
    async fn perder_el_foco_de_la_principal_no_tira_la_nota_del_atajo() {
        let (recorder, _source, _uploads) = setup(TARGET_SAMPLE_RATE, Limits::default());
        recorder.start_companion().await.unwrap();
        recorder.abort_from(Origin::Main);
        assert!(
            recorder.is_recording(),
            "la del atajo se graba con el compacto delante"
        );
        recorder.abort_from(Origin::Shortcut);
        assert!(!recorder.is_recording());

        // Y al revés: la del botón del chat no la tira el atajo.
        recorder.start("ses_1").await.unwrap();
        recorder.abort_from(Origin::Shortcut);
        assert!(recorder.is_recording());
        recorder.abort_from(Origin::Main);
        assert!(!recorder.is_recording());

        // Cerrar Dot las tira todas, sin mirar de quién son.
        recorder.start_companion().await.unwrap();
        recorder.abort();
        assert!(!recorder.is_recording());
    }

    #[tokio::test]
    async fn el_atajo_no_empieza_otra_nota_si_el_chat_ya_graba() {
        let (recorder, _source, _uploads) = setup(TARGET_SAMPLE_RATE, Limits::default());
        recorder.start("ses_1").await.unwrap();
        let error = recorder.start_companion().await.unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Invalid);
        assert_eq!(
            recorder.origin(),
            Some(Origin::Main),
            "la del chat sigue siendo suya"
        );
        recorder.cancel().await.unwrap();
    }

    #[tokio::test]
    async fn la_bandeja_dice_listening_tambien_con_el_atajo() {
        let heard: Arc<Mutex<Vec<bool>>> = Arc::new(Mutex::new(Vec::new()));
        let listener = {
            let heard = heard.clone();
            Arc::new(move |listening: bool| lock(&heard).push(listening)) as Listener
        };
        let source = FakeSource::new(TARGET_SAMPLE_RATE);
        let recorder = VoiceRecorder::new(FakeUploads::new(), Logger::none(), Some(listener))
            .with_source(source.factory())
            .with_limits(Limits::default());
        recorder.start_companion().await.unwrap();
        assert_eq!(*lock(&heard), vec![true], "la bandeja dice «listening…»");
        recorder.cancel().await.unwrap();
        assert_eq!(*lock(&heard), vec![true, false]);
    }

    /// Lo que colgó Dot (2026-11-27): avisar a la bandeja necesita el hilo
    /// principal, y ese hilo, al perder el foco la ventana principal, llama a
    /// `abort_from`. Si `start` tenía cogido el candado de la nota mientras
    /// avisaba, se esperaban el uno al otro para siempre.
    #[tokio::test(flavor = "multi_thread")]
    async fn avisar_a_la_bandeja_no_espera_al_candado_de_la_nota() {
        let cell: Arc<std::sync::OnceLock<Arc<VoiceRecorder<FakeUploads>>>> =
            Arc::new(std::sync::OnceLock::new());
        let answered = Arc::new(AtomicBool::new(false));
        let listener = {
            let cell = cell.clone();
            let answered = answered.clone();
            Arc::new(move |listening: bool| {
                if !listening {
                    return;
                }
                // El «hilo principal»: al perder el foco, `abort_from`.
                let recorder = cell.get().expect("recorder").clone();
                let (done, wait) = std::sync::mpsc::channel();
                std::thread::spawn(move || {
                    recorder.abort_from(Origin::Main);
                    let _ = done.send(());
                });
                if wait.recv_timeout(Duration::from_secs(2)).is_ok() {
                    answered.store(true, Ordering::SeqCst);
                }
            }) as Listener
        };
        let source = FakeSource::new(TARGET_SAMPLE_RATE);
        let recorder = Arc::new(
            VoiceRecorder::new(FakeUploads::new(), Logger::none(), Some(listener))
                .with_source(source.factory())
                .with_limits(Limits::default()),
        );
        let _ = cell.set(recorder.clone());
        recorder.start_companion().await.unwrap();
        assert!(
            answered.load(Ordering::SeqCst),
            "abort_from tiene que contestar mientras start avisa a la bandeja"
        );
        // La nota del atajo sigue: `abort_from(Main)` no la toca.
        assert_eq!(recorder.origin(), Some(Origin::Shortcut));
        recorder.cancel().await.unwrap();
    }

    #[tokio::test]
    async fn el_nivel_es_el_rms_de_lo_ultimo_capturado_y_los_segundos_lo_grabado() {
        let (recorder, source, _uploads) = setup(TARGET_SAMPLE_RATE, Limits::default());
        assert_eq!(
            recorder.progress(),
            None,
            "sin nota no hay nada que enseñar"
        );
        recorder.start("ses_1").await.unwrap();
        let start = recorder.progress().unwrap();
        assert_eq!(start.seconds, 0);
        assert_eq!(start.level, None, "aún no ha llegado ninguna muestra");

        // Medio de fondo de escala (−6,02 dBFS) durante 1 s.
        source.feed(&[0.5f32; 16_000]);
        let loud = recorder.progress().unwrap();
        assert_eq!(loud.seconds, 1);
        let dbfs = loud.level.expect("hay nivel");
        assert!((dbfs + 6.02).abs() < 0.1, "{dbfs}");

        // Silencio: la barra se va al fondo de la escala, nunca a −inf.
        source.feed(&[0.0f32; 8_000]);
        let quiet = recorder.progress().unwrap();
        assert_eq!(quiet.seconds, 1);
        assert!(
            quiet.level.expect("hay nivel") <= -99.0,
            "{:?}",
            quiet.level
        );

        recorder.cancel().await.unwrap();
        assert_eq!(recorder.progress(), None);
    }

    /// A mano, con el micrófono de verdad: no guarda nada, solo dice lo que oye.
    ///
    /// ```text
    /// cargo test -p stratum-dot real_mic_probe -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore]
    fn real_mic_probe() {
        let (rate, channels) = input_format().expect("no microphone");
        let captured: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = {
            let captured = captured.clone();
            Box::new(move |frames: &[f32]| {
                lock(&captured).extend_from_slice(frames);
            }) as FrameSink
        };
        let stop = Arc::new(AtomicBool::new(false));
        let stream = open_stream(channels, sink, &stop).expect("the microphone did not open");
        std::thread::sleep(Duration::from_secs(3));
        drop(stream);
        let samples = lock(&captured);
        let sum: f32 = samples.iter().map(|sample| sample * sample).sum();
        let rms = if samples.is_empty() {
            0.0
        } else {
            (sum / samples.len() as f32).sqrt()
        };
        let dbfs = 20.0 * rms.max(1e-9).log10();
        println!("microphone: {rate} Hz, {channels} channel(s)");
        println!(
            "3 s captured: {} samples; RMS {dbfs:.1} dBFS",
            samples.len()
        );
    }

    /// Lo mismo que `real_mic_probe`, pero con un micrófono **elegido por nombre**
    /// (`DOT_VOICE_PROBE_DEVICE`, un trozo del nombre) y pasando por la mezcla a
    /// mono y el remuestreo de verdad. Lista los dispositivos de entrada. A mano:
    /// `DOT_VOICE_PROBE_DEVICE=reSpeaker cargo test -p stratum-dot real_mic_probe_named -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_mic_probe_named() {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        let wanted = std::env::var("DOT_VOICE_PROBE_DEVICE").unwrap_or_default();
        let host = cpal::default_host();
        let mut chosen = None;
        for device in host.input_devices().expect("no input devices") {
            let name = device.name().unwrap_or_default();
            println!("input: {name}");
            if chosen.is_none() && !wanted.is_empty() && name.contains(&wanted) {
                chosen = Some(device);
            }
        }
        let Some(device) = chosen else {
            println!("no input device matches {wanted:?}");
            return;
        };
        let supported = device.default_input_config().expect("no input config");
        let rate = supported.sample_rate().0;
        let channels = supported.channels().max(1) as usize;
        let format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();
        let captured: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = captured.clone();
        let stream = match format {
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config,
                move |frames: &[i16], _: &_| lock(&sink).extend(mono_i16(frames, channels)),
                |_| {},
                None,
            ),
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config,
                move |frames: &[f32], _: &_| lock(&sink).extend(mono_f32(frames, channels)),
                |_| {},
                None,
            ),
            other => panic!("format {other:?} not covered by the probe"),
        }
        .expect("the microphone did not open");
        stream.play().expect("the microphone did not start");
        let secs = std::env::var("DOT_VOICE_PROBE_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(3u64);
        std::thread::sleep(Duration::from_secs(secs));
        drop(stream);
        let mono = lock(&captured).clone();
        let at16k = if rate == CAPTURE_SAMPLE_RATE {
            let mut resampler = VoiceResampler::new();
            let mut out = Vec::new();
            resampler.push(&mono, &mut out);
            resampler.finish(&mut out);
            out
        } else {
            mono.clone()
        };
        let sum: f32 = at16k.iter().map(|sample| sample * sample).sum();
        let rms = (sum / at16k.len().max(1) as f32).sqrt();
        // Solo en esta prueba manual y solo si se pide: el WAV de 16 kHz, para
        // pasarlo luego por `voice.*`. El código de Dot nunca escribe audio.
        if let Ok(path) = std::env::var("DOT_VOICE_PROBE_WAV") {
            let pcm: Vec<i16> = at16k
                .iter()
                .map(|s| (s * 32_767.0).round().clamp(-32_768.0, 32_767.0) as i16)
                .collect();
            let data = pcm_bytes(&pcm);
            let mut wav = Vec::with_capacity(44 + data.len());
            wav.extend_from_slice(b"RIFF");
            wav.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
            wav.extend_from_slice(b"WAVEfmt ");
            wav.extend_from_slice(&16u32.to_le_bytes());
            wav.extend_from_slice(&1u16.to_le_bytes());
            wav.extend_from_slice(&1u16.to_le_bytes());
            wav.extend_from_slice(&TARGET_SAMPLE_RATE.to_le_bytes());
            wav.extend_from_slice(&(TARGET_SAMPLE_RATE * 2).to_le_bytes());
            wav.extend_from_slice(&2u16.to_le_bytes());
            wav.extend_from_slice(&16u16.to_le_bytes());
            wav.extend_from_slice(b"data");
            wav.extend_from_slice(&(data.len() as u32).to_le_bytes());
            wav.extend_from_slice(&data);
            std::fs::write(&path, wav).expect("could not write the probe WAV");
        }
        println!("chosen: {rate} Hz, {channels} channel(s), {format:?}");
        println!(
            "{secs} s captured: {} samples at {rate} Hz, {} at 16 kHz; RMS {:.1} dBFS",
            mono.len(),
            at16k.len(),
            20.0 * rms.max(1e-9).log10()
        );
    }
}
