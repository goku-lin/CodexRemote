export function turnControls(session, online = true) {
  const running = ['running', 'waiting_input', 'waiting_approval'].includes(session?.status);
  return { steer: Boolean(online && running && session?.controls?.steer),
    interrupt: Boolean(online && running && session?.controls?.interrupt) };
}
export function turnInput(session, text, attachments, choices) {
  return ['running','starting','waiting_input','waiting_approval','interrupting'].includes(session?.status)
    ? { text, attachments, ...choices,mode:'queue', expectedTurnId:session.activeTurnId }
    : { text, attachments, ...choices };
}
