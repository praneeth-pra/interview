// Interview rounds are free text ("2nd round", "Final", "HR screen"). roundRank() turns them into a number: 0 screen, 1..n, 90 final.
var WORDS = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
};
function roundKey(round) {
  return String(round || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}
function roundRank(round) {
  var key = roundKey(round);
  if (!key) {
    return null;
  }
  if (/final|last|offer/.test(key)) {
    return 90;
  }
  var number = key.match(/\d+/);
  if (number) {
    return +number[0];
  }
  for (var word in WORDS) {
    if (key.indexOf(word) >= 0) {
      return WORDS[word];
    }
  }
  if (/screen|phone|intro/.test(key)) {
    return 0;
  } else {
    return null;
  }
}
function bucketOf(rank) {
  if (rank <= 1) {
    return 0;
  } else if (rank === 2) {
    return 1;
  } else if (rank === 3) {
    return 2;
  } else if (rank < 90) {
    return 3;
  } else {
    return 4;
  }
}
function ordinal(number) {
  var lastTwo = number % 100;
  return (
    number + (lastTwo >= 11 && lastTwo <= 13 ? "th" : number % 10 == 1 ? "st" : number % 10 == 2 ? "nd" : number % 10 == 3 ? "rd" : "th")
  );
}
function roundShort(round) {
  var rank = roundRank(round);
  if (rank === 90) {
    return "Final";
  } else if (rank === 0) {
    return "Screen";
  } else if (rank !== null) {
    return ordinal(rank);
  } else {
    return (
      String(round || "")
        .trim()
        .slice(0, 10) || "Interview"
    );
  }
}

export { roundKey, roundRank, bucketOf, ordinal, roundShort };
