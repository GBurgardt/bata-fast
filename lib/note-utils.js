export const parseMatchInput = (value = "") =>
  String(value)
    .split(/[,/]|(?:\r?\n)/)
    .map((part) => part.trim())
    .filter(Boolean);
