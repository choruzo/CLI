---
name: stratum-images
description: Úsala antes de generar una imagen con generate_image — cuando el usuario pida dibujar, generar, crear o diseñar una imagen, ilustración, foto, logo, icono, póster o fondo de pantalla, o use /imagen — y antes de retocar una que ya generaste.
presets: [assistant]
---

# Generar imágenes con `generate_image`

La tool manda **un prompt de texto** a un modelo de imágenes (difusión) y deja las imágenes en `outputs/`; Desktop las enseña en el chat. Tú no dibujas: tu trabajo es escribir la petición. El modelo de imágenes no ve la conversación, solo tu prompt: todo lo que importe tiene que estar escrito en él.

Si no tienes la tool `generate_image`, dilo así: la generación de imágenes no está configurada, y se activa con una sección `imageGeneration` (`provider` y `model` de imágenes) en la config global `~/.stratum/.stratumrc.json`. No describas la imagen como si la hubieras hecho.

## Antes de llamar

- Si la petición es clara (un tema y, aunque sea implícito, un estilo), **genera sin preguntar**: lo que falte, elígelo tú con criterio.
- Pregunta solo si falta algo que cambia el resultado y no puedes suponer: el texto exacto de un logo o un cartel, a quién o qué debe parecerse, el formato de destino («para una portada de YouTube» ⇒ 16:9).
- Una llamada por petición. No generes variantes que nadie pidió; si el usuario quiere opciones, `n` de 2 a 4 en una sola llamada.

## Cómo escribir el `prompt`

En **inglés** aunque el usuario escriba en otro idioma (los modelos de imágenes lo entienden mucho mejor), en un párrafo descriptivo, de 40 a 120 palabras, en este orden:

1. **Sujeto**: qué es y cómo es, con detalles concretos (edad, ropa, materiales, cantidad, pose, expresión).
2. **Acción y entorno**: qué hace, dónde, época, hora del día, clima.
3. **Composición**: plano (close-up, medium shot, wide shot), ángulo (eye level, low angle, top-down), encuadre, qué ocupa el primer plano y el fondo.
4. **Estilo o medio**: fotografía (lente, profundidad de campo: «35mm photo, shallow depth of field»), acuarela, óleo, ilustración plana vectorial, 3D render, pixel art, anime, grabado…
5. **Luz y color**: «soft golden-hour light», «high-key studio lighting», paleta concreta.
6. **Ambiente**: sereno, dramático, alegre, misterioso.

Reglas:

- Describe lo que **sí** debe aparecer. Los negativos («no people», «without text») a menudo hacen aparecer justo eso: escribe la escena sin ello («an empty street»).
- Sé concreto: «a weathered red fishing boat» mejor que «a nice boat».
- Texto dentro de la imagen: entre comillas y corto (`a sign that reads "OPEN"`); avisa de que los modelos a veces lo escriben mal.
- Personas reales, marcas y estilos de artistas vivos concretos: no los imites; describe el estilo con palabras («bold flat colours, thick outlines»).
- Nada sexual explícito, de odio o de violencia gráfica, ni imágenes de personas reales en situaciones comprometedoras.

## `size`, `n` y `name`

| Para qué | `size` |
|---|---|
| Cuadrada (avatar, icono, post) — por defecto | `1024x1024` |
| Horizontal (paisaje, portada, fondo de escritorio) | `1344x768` o `1024x768` |
| Vertical (póster, móvil, retrato) | `768x1344` o `768x1024` |

Si el provider rechaza un tamaño, repite una vez con `1024x1024` y díselo al usuario. `name`: corto, descriptivo, en el idioma del usuario (`zorro-acuarela`).

## Después

- Responde en una o dos frases: qué has generado y una oferta concreta de ajuste («¿Lo quieres más cálido o en formato vertical?»). No pegues las rutas ni la imagen en markdown: el chat ya la enseña.
- **Retocar** («más oscuro», «quítale el sombrero»): el modelo no edita la imagen anterior, genera otra. Reescribe el prompt anterior entero con el cambio aplicado y mantén lo demás igual para que se parezca.
- Si la tool falla, di por qué con sus palabras y qué se puede probar; no reintentes en bucle.

## Ejemplo

Usuario: «hazme un dibujo de un gato astronauta»

```json
{
  "prompt": "A fluffy orange tabby cat wearing a white retro astronaut suit with a glass bubble helmet, floating weightlessly inside a cosy spaceship cabin, paws reaching toward a drifting fish-shaped toy. Round porthole behind it showing Earth and stars. Medium shot, eye level. Whimsical children's book illustration, soft gouache textures, warm pastel palette with teal accents, gentle diffuse lighting, playful and cheerful mood.",
  "size": "1024x1024",
  "name": "gato-astronauta"
}
```
