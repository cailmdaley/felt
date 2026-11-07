/**
 * A large family with a working hub's shape: forty-two threads two and three
 * levels deep, most of them finished, a dozen asking, and uneven weeks of
 * launches, commits and sent files. The board harness stages it and the sky's
 * collision test measures it.
 */
export type HubState = 'work' | 'turn' | 'ask' | 'blocked' | 'review' | 'new' | 'done' | 'discard' | 'draft' | 'rest'
export interface HubRow {
  id: string
  name: string
  parent?: string
  state: HubState
  /** Hours since the thread last moved. */
  hours: number
  launches: number
  commits: number
  files: number
  note: string
}
const row = (id: string, name: string, parent: string | undefined, state: HubState, hours: number, launches: number, commits: number, files: number, note: string): HubRow =>
  ({ id, name, parent, state, hours, launches, commits, files, note })

const HUB = 'hub'
export const HUB_ROWS: readonly HubRow[] = [
  row(HUB, 'Shear survey hub', undefined, 'work', .2, 1, 0, 2, 'The v3 catalogue is on the cluster; threads move one at a time, starting with the mocks.'),
  row('hub/staging', 'Staging and production runs', HUB, 'turn', 1, 11, 69, 1, 'Run 2 finished on all tiles; two exposures need your call before the merge.'),
  row('hub/staging/audit', 'Audit the tile manifest against the archive', 'hub/staging', 'done', 840, 0, 0, 0, 'The manifest matches the archive.'),
  row('hub/staging/loop', 'Implementation and patch-test loop', 'hub/staging', 'done', 294, 1, 0, 4, 'Patch tests pass at the ten-tile scale.'),
  row('hub/staging/admit', 'Admit new batches into the publication', 'hub/staging', 'done', 292, 2, 0, 1, 'Batches now pass the admission checks.'),
  row('hub/staging/quota', 'Fail fast on the quota check', 'hub/staging', 'done', 321, 2, 0, 1, 'A rebuild stops before it fills the project space.'),
  row('hub/staging/g19', 'Fast-forward the production footprint', 'hub/staging', 'done', 320, 1, 0, 0, 'Production holds the reclaimed footprint.'),
  row('hub/coworking', 'Weekly coworking', HUB, 'rest', 922, 0, 0, 0, ''),
  row('hub/second-site', 'Production on the second site', HUB, 'rest', 183, 9, 2, 0, 'Waiting for the allocation to renew.'),
  row('hub/second-site/unmatched', 'Unmatched catalogue objects on two tiles', 'hub/second-site', 'done', 287, 1, 0, 0, 'A boundary rounding error, fixed.'),
  row('hub/validation-steward', 'Validation repository steward', HUB, 'work', .3, 1, 0, 0, 'Reviewing the open pull requests.'),
  row('hub/validation-steward/leakage', 'Leakage estimator and the star mask', 'hub/validation-steward', 'done', 175, 1, 0, 0, 'Merged with the star-contamination mask.'),
  row('hub/validation-steward/blends', 'Blends in the bound-nine selection', 'hub/validation-steward', 'done', 167, 1, 0, 1, 'Admitting them costs two percent of the sample.'),
  row('hub/pipeline-steward', 'Pipeline repository steward', HUB, 'ask', 3, 32, 0, 5, 'Should the workflow rewrite land before the cut, or after it?'),
  row('hub/pipeline-steward/simplify', 'Workflow simplification', 'hub/pipeline-steward', 'review', 103, 1, 0, 0, 'The operational path is down to six steps; ready for a verdict.'),
  row('hub/pipeline-steward/flags', 'Propagate defect flags from exposure to tile', 'hub/pipeline-steward', 'done', 319, 1, 6, 0, 'Flags survive stacking.'),
  row('hub/pipeline-steward/match', 'Should the catalogue cut tiles on the match fraction?', 'hub/pipeline-steward', 'review', 104, 4, 0, 0, 'The cut removes three percent of the area and no bias; read the summary.'),
  row('hub/pipeline-steward/architecture', 'Run-2 architecture with partitioned outputs', 'hub/pipeline-steward', 'review', 180, 6, 15, 2, 'The partitioned layout is drawn and costed.'),
  row('hub/pipeline-steward/rebuild', 'Rebuild the workflow from the run-1 lessons', 'hub/pipeline-steward', 'blocked', 2.5, 1, 0, 0, 'The container build fails on the new base image.'),
  row('hub/pipeline-steward/rebuild/weights', 'Weight maps on real exposures', 'hub/pipeline-steward/rebuild', 'draft', 103, 2, 0, 0, ''),
  row('hub/pipeline-steward/merge', 'Merge the edge branch', 'hub/pipeline-steward', 'work', .4, 1, 0, 0, 'Rebasing on the morning push.'),
  row('hub/cosmology', 'Blinded cosmology on the growing catalogue', HUB, 'done', 169, 16, 2, 32, 'The blinded chains converge.'),
  row('hub/psf-coupling', 'Why the new shapes couple more to PSF model errors', HUB, 'new', 5, 12, 0, 3, 'A worked answer with four figures.'),
  row('hub/port', 'Port the validation workflow to the new runner', HUB, 'draft', 266, 0, 0, 0, ''),
  row('hub/figures', 'Add the paper figures to validation', HUB, 'done', 247, 2, 11, 0, 'Every figure now regenerates from the workflow.'),
  row('hub/learn', 'Learn from the blinded full-area run', HUB, 'review', 106, 5, 0, 2, 'Three lessons, one of them about the covariance.'),
  row('hub/mocks', 'Non-tomographic mock through validation', HUB, 'turn', 3.2, 6, 3, 1, 'The mock reproduces the data vector; choose the next realisation count.'),
  row('hub/mocks/dashboard', 'A validation section on the dashboard', 'hub/mocks', 'review', 110, 3, 0, 0, 'The section is drafted behind a flag.'),
  row('hub/mocks/crosscheck', 'Cross-check the mock implementations', 'hub/mocks', 'done', 140, 1, 0, 1, 'The two mocks agree at one percent.'),
  row('hub/blind-records', 'Check the second site for blind records', HUB, 'done', 190, 1, 0, 0, 'None found.'),
  row('hub/response', 'Shear response on the deep tiles', HUB, 'ask', 8, 7, 12, 3, 'Fit the response per tile, or per run?'),
  row('hub/response/noise', 'Noise bias at low signal to noise', 'hub/response', 'work', 1.4, 3, 5, 0, 'Running the second batch of image simulations.'),
  row('hub/response/selection', 'Selection response at the faint end', 'hub/response', 'review', 30, 4, 2, 1, 'Faint-end response is stable to a third of a percent.'),
  row('hub/footprint', 'Footprint and masks for the release', HUB, 'turn', 26, 4, 9, 2, 'The mask is frozen; sign off before the release branch.'),
  row('hub/footprint/stars', 'Bright-star halos at the survey edge', 'hub/footprint', 'done', 400, 1, 0, 1, 'Halo radii refit at the edge.'),
  row('hub/photo-z', 'Photometric redshift calibration', HUB, 'new', 2, 8, 4, 4, 'The calibration report for the third bin arrived.'),
  row('hub/photo-z/bin-three', 'Third-bin outliers', 'hub/photo-z', 'done', 96, 2, 3, 2, 'The outliers are stars.'),
  row('hub/photo-z/clustering', 'Clustering redshifts against the spectroscopic overlap', 'hub/photo-z', 'work', 3.5, 3, 6, 1, 'Cross-correlating the fourth bin.'),
  row('hub/notes', 'Notes for the collaboration meeting', HUB, 'draft', 150, 0, 0, 0, ''),
  row('hub/old-pilot', 'Pilot on the early footprint', HUB, 'discard', 500, 1, 0, 0, 'Superseded by the first production run.'),
  row('hub/calibration', 'Calibration of the star catalogue', HUB, 'rest', 210, 2, 1, 0, 'Picked back up once the masks are frozen.'),
  row('hub/ingest', 'Ingest the new exposures', HUB, 'done', 220, 3, 8, 0, 'All exposures ingested.'),
]

/** Times back from the thread's last move, in the uneven bursts real work comes in. */
export function hubTimes(row: HubRow, count: number, now: number): number[] {
  let seed = [...row.id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 65_521, 7)
  const next = (): number => (seed = (seed * 75 + 74) % 65_537) / 65_537
  const hours: number[] = []
  let back = row.hours
  for (let n = 0; n < count; n++) {
    hours.push(back)
    back += next() < .7 ? next() * 1.5 : next() * 40
  }
  return hours.map(at => now - at * 3_600_000)
}
