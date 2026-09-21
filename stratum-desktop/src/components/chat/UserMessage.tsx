/** Mensaje del usuario: texto plano, nunca markdown (es lo que escribió). */
export function UserMessage({ text }: { text: string }) {
  return (
    <div className="message message--user">
      <div className="message__bubble">{text}</div>
    </div>
  );
}
