// What Ask tells a visitor at a limit. One place, so the server's answer and the page's own wording never drift apart.

/** Questions one visitor may ask in a London day. */
export const ASK_PER_VISITOR = 5;

export const ASK_RESTING = 'Ask is resting for today. The filters and For you still work.';
export const askLimited = (perVisitor: number) => `You have used today's ${perVisitor} questions. Come back tomorrow. The filters and For you still work.`;
