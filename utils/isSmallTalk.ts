// utils/isSmallTalk.ts
export const isSmallTalk = (text: string) => {
  const t = text.trim().toLowerCase();
  const greetings = ["hi", "hello", "hey", "yo", "good morning", "good afternoon", "good evening"];
  const small = ["thanks", "thank you", "thx", "bye", "goodbye"];
  if (greetings.includes(t) || small.includes(t)) return true;
  // very short messages likely small talk
  if (t.length < 6 && /^[a-z]+$/.test(t)) return true;
  return false;
};
