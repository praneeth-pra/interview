// People's names typed into bookings vary ("Priya Sharma", "sharma priya", "Karthik Redy"). sameName() decides whether
// two spellings are the same person, for grouping Contacts; samePerson() is looser (a first name alone matches the full
// name) and keeps two different people from booking under one email.
export function normalizeName(name: string) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
// edits (insert, delete, change, swap two neighbours) between two strings
export function nameDistance(first: string, second: string) {
  const rows = first.length;
  const cols = second.length;
  const table = [];
  let i;
  let j;
  for (i = 0; i <= rows; i++) {
    table[i] = [i];
    for (j = 1; j <= cols; j++) {
      table[i][j] = i ? 0 : j;
    }
  }
  for (i = 1; i <= rows; i++) {
    for (j = 1; j <= cols; j++) {
      table[i][j] = Math.min(table[i - 1][j] + 1, table[i][j - 1] + 1, table[i - 1][j - 1] + (first[i - 1] === second[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && first[i - 1] === second[j - 2] && first[i - 2] === second[j - 1]) {
        table[i][j] = Math.min(table[i][j], table[i - 2][j - 2] + 1);
      }
    }
  }
  return table[rows][cols];
}
export function sameName(first: string, second: string) {
  const firstKey = normalizeName(first);
  const secondKey = normalizeName(second);
  if (!firstKey || !secondKey || firstKey === "guest" || secondKey === "guest") {
    return false;
  }
  if (firstKey === secondKey) {
    return true;
  }
  const firstWords = firstKey.split(" ");
  const secondWords = secondKey.split(" ");
  if (firstWords.length < 2 || secondWords.length < 2) {
    return false;
  }
  if (firstWords.slice().sort().join(" ") === secondWords.slice().sort().join(" ")) {
    return true;
  }
  return (
    firstKey.length >= 8 &&
    secondKey.length >= 8 &&
    Math.abs(firstKey.length - secondKey.length) <= 1 &&
    nameDistance(firstKey, secondKey) <= 1
  );
}
// The same person, or a shorter way of writing them: sameName, or every word of one name is in the other ("Hareesh" and
// "Hareesh Kumar"). "Hemanth" and "Hareesh" are two people.
export function samePerson(first: string, second: string) {
  const firstWords = normalizeName(first).split(" ").filter(Boolean);
  const secondWords = normalizeName(second).split(" ").filter(Boolean);
  if (!firstWords.length || !secondWords.length) {
    return true; // nothing to compare
  }
  if (sameName(first, second)) {
    return true;
  }
  const [short, long] = firstWords.length <= secondWords.length ? [firstWords, secondWords] : [secondWords, firstWords];
  return short.every(function (word) {
    return long.indexOf(word) >= 0;
  });
}
