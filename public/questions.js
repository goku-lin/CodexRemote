export function normalizeQuestions(questions, callId, delivery = 'async') {
  return (Array.isArray(questions) ? questions : []).slice(0, 3).map((question, index) => ({
    id: String(question.id || JSON.stringify([delivery === 'async' ? 'request_user_input_async' : 'request_user_input', callId, index])),
    title: String(question.title || question.question || ''),
    isSecret: Boolean(question.isSecret),
    options: (question.options || []).map(option => typeof option === 'string' ? { label: option } : { label: String(option.label || ''), description: String(option.description || '') })
  })).filter(question => question.title);
}

export function questionReplies(text) {
  const match = String(text || '').match(/<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/);
  if (!match) return [];
  try {
    const replies = JSON.parse(match[1]);
    return Array.isArray(replies) ? replies.filter(reply => typeof reply.questionItemId === 'string' && typeof reply.answer === 'string') : [];
  } catch { return []; }
}

export function questionCallId(questionId) {
  try { const parts = JSON.parse(questionId); return Array.isArray(parts) && parts.length === 3 ? String(parts[1]) : null; }
  catch { return null; }
}

export function questionReplyMessage(questions, answers) {
  return '回答你刚才的问题：\n\n' + questions.map(question=>`问题：${question.title}\n回答：${answers[question.id]}`).join('\n\n');
}

export function forwardedQuestionReplies(text) {
  const value=String(text || '').trim();
  if (!value.startsWith('回答你刚才的问题：\n\n')) return [];
  return [...value.slice('回答你刚才的问题：\n\n'.length).matchAll(/(?:^|\n\n)问题：([\s\S]*?)\n回答：([\s\S]*?)(?=\n\n问题：|$)/g)].map(match=>({question:match[1],answer:match[2]}));
}

export function validateQuestionAnswers(questions, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请选择选项或输入回答。');
  const answers = {};
  for (const question of questions) {
    const answer = input[question.id];
    if (typeof answer !== 'string' || !answer.trim()) throw new Error('请回答每个问题。');
    if (answer.length > 8000) throw new Error('回答过长，请缩短后重试。');
    answers[question.id] = answer.trim();
  }
  if (Object.keys(input).some(id => !questions.some(question => question.id === id))) throw new Error('问题已变化，请刷新后重试。');
  return answers;
}

export function questionReplyText(questions, answers) {
  return '<send_user_message_question_reply>\n' + JSON.stringify(questions.map(question => ({
    questionItemId: question.id, question: question.title, answer: answers[question.id]
  }))) + '\n</send_user_message_question_reply>';
}
