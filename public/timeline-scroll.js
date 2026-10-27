const anchorSelector = '.process-note, .process-item, .process-group > summary, .turn-history > summary, .message, .turn-live';

// New user inputs position the conversation once. Output updates preserve the
// reader's place, including when they happen to be at the bottom of the view.
export class TimelineViewport {
  constructor() {
    this.sessionId = null;
    this.inputId = null;
    this.positions = new Map();
    this.bottomSpace = 0;
  }

  capture(messages, sessionId, inputId) {
    const switched = this.sessionId !== sessionId;
    if (switched && this.sessionId) {
      this.positions.set(this.sessionId, { top: messages.scrollTop, inputId: this.inputId });
    }
    const previous = switched ? this.positions.get(sessionId) : { top: messages.scrollTop, inputId: this.inputId };
    const bounds = messages.getBoundingClientRect();
    const anchors = switched ? [] : [...messages.querySelectorAll(anchorSelector)].flatMap(node => {
      const rect = node.getBoundingClientRect();
      return rect.bottom > bounds.top && rect.top < bounds.bottom ? [{ node, top: rect.top }] : [];
    });
    return { sessionId, inputId, switched, top: previous?.top || 0, anchors,
      positionInput: Boolean(inputId && inputId !== previous?.inputId) };
  }

  restore(messages, snapshot) {
    const user = [...messages.querySelectorAll('.message.you[data-message-id]')]
      .find(node => node.dataset.messageId === snapshot.inputId);
    // Steering input can be near the end of a long, already-running turn.
    // Reserve only the space missing below that input, then consume it as
    // output grows so the scroll range does not shrink on every update.
    const naturalHeight = messages.scrollHeight - this.bottomSpace;
    const inputTop = user ? messages.scrollTop + user.getBoundingClientRect().top - messages.getBoundingClientRect().top : 0;
    const space = user ? Math.max(0, Math.ceil(inputTop - 16 + messages.clientHeight - naturalHeight)) : 0;
    if (space !== this.bottomSpace) messages.style.setProperty('--timeline-bottom-space', `${space}px`);
    this.bottomSpace = space;
    let positioned = !snapshot.positionInput;
    if (snapshot.positionInput) {
      if (user) {
        messages.scrollTop += user.getBoundingClientRect().top - messages.getBoundingClientRect().top - 16;
        positioned = true;
      }
    } else {
      const anchor = snapshot.anchors.find(entry => entry.node.isConnected);
      messages.scrollTop = snapshot.top + (anchor ? anchor.node.getBoundingClientRect().top - anchor.top : 0);
    }
    this.sessionId = snapshot.sessionId;
    if (positioned) this.inputId = snapshot.inputId || (snapshot.switched ? null : this.inputId);
    else if (snapshot.switched) this.inputId = null;
  }
}
