// ============================================================
// claims.js — what every published number claims, and how to check it
// ============================================================
//
// THE GAP THIS CLOSES. Tests check that a number is computed as intended.
// Invariants check it is internally consistent. Mutation testing checks the
// tests would notice if the code changed. None of them can tell you a number
// is computed perfectly and MEANS SOMETHING ELSE.
//
// The example that made the point is in this repo. Lineup efficiency —
// what you started over the best you could have started — correlates 0.450 with
// winning. Every check passes. Any site would print it as a Manager Rating.
// And a manager efficient in the first half of a season is no more likely to be
// efficient in the second: split-half r = -0.036. There is no person in the
// number. It correlates with winning because looking efficient and winning are
// both downstream of the same weeks — your best players boom, so you win AND
// your lineup looks optimal in hindsight.
//
// THE FIX IS TO MAKE THE CLAIM EXPLICIT AND THEN TEST THE CLAIM, and which test
// depends on what the number says it is about:
//
//   a number about a SITUATION must PREDICT      playoff odds, power rankings
//   a number about a PERSON must PERSIST         manager ratings, "tendencies"
//
// Persistence is the test almost nobody runs, and it is the one that catches
// this class. A metric about a person that does not survive a split-half is
// describing the season, not the person.
//
// Every claim below is scored against completed seasons by
// scripts/score-claims.js, which runs in CI and daily. A claim that stops
// holding is a change in the world or a bug, and either way the page that
// prints the number should stop saying what it currently says.

/**
 * @property id        stable key, so a score can be tracked over time
 * @property metric    the number as a reader sees it
 * @property about     'situation' | 'person'  — decides which test applies
 * @property claim     the sentence the page is allowed to say
 * @property test      'predicts' | 'persists'
 * @property floor     below this the claim is no longer supported
 * @property published where a reader meets the number
 */
const CLAIMS = [
  {
    id: 'playoff-odds',
    metric: 'Playoff odds',
    about: 'situation',
    claim: 'Teams given a higher chance of making the playoffs make them more often.',
    test: 'predicts',
    floor: 0.30,
    published: 'Playoff Odds tab',
  },
  {
    id: 'all-play',
    metric: 'All-play record (the power ranking)',
    about: 'situation',
    claim: 'A better all-play record now means a better win rate over the rest of the season.',
    test: 'predicts',
    floor: 0.10,
    published: 'Power Rankings tab',
  },
  {
    id: 'roster-quality',
    metric: 'Roster quality (points the roster was worth)',
    about: 'situation',
    claim: 'A stronger roster now wins more over the rest of the season.',
    test: 'predicts',
    floor: 0.30,
    published: 'Manager profile',
  },
  {
    id: 'added-in-season',
    metric: 'Added in-season — points started from players neither drafted nor kept',
    about: 'person',
    claim: 'A manager who works the wire does it again. It is who they are — and it is '
         + 'explicitly NOT why they win: this is published as an identity, never as a rating.',
    test: 'persists',
    floor: 0.50,
    published: 'Manager profile',
    // A SECOND CLAIM ON THE SAME NUMBER, and the one that keeps the page
    // honest. The first version of this metric counted kept players as
    // acquisitions — this is a keeper league and a keeper never appears in the
    // draft — and concluded wire work was a skill worth 0.912. Separated
    // properly it persists at 0.895 and predicts winning at 0.021. If it ever
    // starts predicting, the page is understating it and should be re-read.
    alsoMustNotPredict: 0.25,
  },
  {
    id: 'lineup-efficiency',
    metric: 'Lineup efficiency',
    about: 'person',
    claim: 'NOT A SKILL. Reported as a description of what happened, never as a rating '
         + 'of the manager. It correlates with winning and does not persist, so it '
         + 'describes the season rather than the person.',
    test: 'persists',
    floor: null,          // deliberately unsupported — see `expectFail`
    expectFail: true,
    published: 'Manager profile, labelled',
  },
  {
    id: 'draft-grade',
    metric: 'Draft grade',
    about: 'situation',
    claim: 'NOT PREDICTIVE. Printed with its own correlation beside it, as a description '
         + 'of what a draft returned rather than a forecast of a season.',
    test: 'predicts',
    floor: null,
    expectFail: true,
    published: 'Draft Grades tab, with the number shown',
  },
];

module.exports = { CLAIMS };
