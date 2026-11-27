// The main Singapore drive: what "Start your journey" and the home garage
// open, and the one course every check, review and re-check runs on (the
// user's rule, 26 Nov: test the course the player actually drives). Change
// it here only; tools/check/run.cjs reads MAIN_COURSE from this file and
// its "one course" check fails if the menu or a garage names another.
export const MAIN_COURSE = 'whole';
export const MAIN_MAP = 'maps/east-redrawn.json';
