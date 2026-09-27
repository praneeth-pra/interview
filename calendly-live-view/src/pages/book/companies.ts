// Company suggestions for the booking form: known companies from /api/companies, matched as the candidate types.
// A known company and every name it goes by; `popularity` is how many candidates have booked with it.
type Term = { raw: string; alias: boolean; key: string; words: string[] };
type Company = { name: string; popularity: number; terms: Term[] };
// as /api/companies sends it: the name, other names it goes by, and how many candidates booked with it
type ApiCompany = { n: string; a?: string[]; f?: number };
export type Match = { name: string; popularity: number; score: number; via: string | null };
var companies: Company[] | null = null;
var companiesLoading = false;
var companyWaiters: Array<() => void> = [];
function compact(text: string) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}
function loadCompanies(callback?: () => void) {
  if (companies) {
    if (callback) {
      callback();
    }
    return;
  }
  if (callback) {
    companyWaiters.push(callback);
  }
  if (!companiesLoading) {
    companiesLoading = true;
    fetch("/api/companies")
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        companies = (data.companies || []).map(function (company: ApiCompany) {
          var names = [company.n].concat(company.a || []);
          return {
            name: company.n,
            popularity: company.f || 0,
            terms: names.map(function (raw, index) {
              return {
                raw: raw,
                alias: index > 0,
                key: compact(raw),
                words: raw
                  .toLowerCase()
                  .split(/[^a-z0-9]+/)
                  .filter(Boolean),
              };
            }),
          };
        });
        companiesLoading = false;
        var waiters = companyWaiters;
        companyWaiters = [];
        waiters.forEach(function (waiter) {
          waiter();
        });
      })
      .catch(function () {
        companiesLoading = false;
        companyWaiters = [];
      });
  }
}
// Best matches for what the candidate typed: exact name, then prefix, then word prefix, then substring; aliases rank a bit lower.
function suggestCompanies(query: string): Match[] {
  var key = compact(query);
  if (!key || !companies) {
    return [];
  }
  var matches: Match[] = [];
  companies.forEach(function (company) {
    var best = 9;
    var via = null;
    company.terms.forEach(function (term) {
      var score = 9;
      if (term.key === key) {
        score = 0;
      } else if (term.key.indexOf(key) === 0) {
        score = 1;
      } else if (
        term.words.some(function (word) {
          return word.indexOf(key) === 0;
        })
      ) {
        score = 2;
      } else if (key.length >= 3 && term.key.indexOf(key) > 0) {
        score = 3;
      }
      if (score < 9 && term.alias) {
        score += 0.5;
      }
      if (score < best) {
        best = score;
        via = term.alias ? term.raw : null;
      }
    });
    if (best < 9) {
      matches.push({
        name: company.name,
        popularity: company.popularity,
        score: best,
        via: via,
      });
    }
  });
  matches.sort(function (x, y) {
    return (
      x.score - y.score || y.popularity - x.popularity || x.name.length - y.name.length || x.name.localeCompare(y.name)
    );
  });
  return matches.slice(0, 8);
}

export { companies, compact, loadCompanies, suggestCompanies };
