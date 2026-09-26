// Company names typed by candidates vary ("TCS", "Tata Consultancy Services Pvt Ltd"...). sameCompany() decides whether two
// spellings are the same company; the server uses it to keep a candidate's spelling the same across rounds.
var SUFFIX = {
  pvt: 1,
  ltd: 1,
  private: 1,
  limited: 1,
  inc: 1,
  llp: 1,
  corp: 1,
  corporation: 1,
  co: 1,
  company: 1,
  technologies: 1,
  technology: 1,
  solutions: 1,
  services: 1,
  india: 1,
  global: 1,
  group: 1,
  systems: 1,
  software: 1,
  labs: 1,
};
function digits(text) {
  return text.replace(/\D/g, "");
}
function sameCompany(first, second) {
  var firstKey = simKey(first);
  var secondKey = simKey(second);
  if (!firstKey || !secondKey) {
    return false;
  }
  var firstCompact = firstKey.replace(/ /g, "");
  var secondCompact = secondKey.replace(/ /g, "");
  if (digits(firstCompact) !== digits(secondCompact)) {
    return false;
  }
  if (firstCompact === secondCompact) {
    return true;
  }
  var shorter = Math.min(firstCompact.length, secondCompact.length);
  var longer = Math.max(firstCompact.length, secondCompact.length);
  return shorter >= 5 && osaDistance(firstCompact, secondCompact) <= (longer <= 9 ? 1 : 2);
}
function osaDistance(first, second) {
  var i;
  var j;
  var rows = first.length;
  var cols = second.length;
  var table = [];
  for (i = 0; i <= rows; i++) {
    table[i] = [i];
  }
  for (j = 1; j <= cols; j++) {
    table[0][j] = j;
  }
  for (i = 1; i <= rows; i++) {
    for (j = 1; j <= cols; j++) {
      var cost = first[i - 1] === second[j - 1] ? 0 : 1;
      table[i][j] = Math.min(table[i - 1][j] + 1, table[i][j - 1] + 1, table[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && first[i - 1] === second[j - 2] && first[i - 2] === second[j - 1]) {
        table[i][j] = Math.min(table[i][j], table[i - 2][j - 2] + 1);
      }
    }
  }
  return table[rows][cols];
}
function simKey(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => word && !SUFFIX[word])
    .join(" ");
}

export { sameCompany };
