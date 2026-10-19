// One classifier shared by the documentation gate and its synthetic controls.
export function classifyObservations(observations) {
  return {
    held: observations.filter(o => !o.declared && o.evaluated && o.ok),
    owed: observations.filter(o => o.declared && o.evaluated && !o.ok),
    paid: observations.filter(o => o.declared && o.evaluated && o.ok),
    regressions: observations.filter(o => !o.declared && o.evaluated && !o.ok),
    unevaluable: observations.filter(o => !o.evaluated),
  }
}
