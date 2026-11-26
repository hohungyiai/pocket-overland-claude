// In-page check: saving (src/save.ts). A save turns into a save code and
// back unchanged; a code with any one character changed, or cut short, is
// refused; the older camp-only save still loads; and the game's own
// autosave puts back the car where it is, keeping your place on other drives.
window.__checkSaveCodes = () => {
  const s = window.game.save;
  const bad = [];
  const cases = [
    { course: 'whole', x: -789.4, z: 1589.2, y: 12.3, yaw: 1.234, label: 'Our Tampines Hub', style: 'detailed', odo: 42345, fuel: 0.733, home: 'tampines-hub', garages: ['tampines-hub'], savedAt: 1795000000000, backupOdo: 0, backupAt: 0 },
    { course: 'eastcoast', x: 10, z: -20, yaw: -3.1, label: 'Camp Area G · 東海岸', style: 'stylized', camp: 'g', odo: 0, savedAt: 1795000001000, backupOdo: 0, backupAt: 0 },
    { course: 'ubintrail', x: 0, z: 0, yaw: 0, label: '', odo: 1e7, savedAt: 1795000002000, backupOdo: 0, backupAt: 0 },
  ];
  let samples = 0;
  for (const j of cases) {
    const code = s.encodeCode(j);
    const back = s.decodeCode(code);
    samples++;
    for (const k of ['course', 'label', 'camp', 'home']) if ((back?.[k] ?? '') !== (j[k] ?? '')) bad.push({ case: j.course, field: k, over: 1 });
    // (No style saved reads as the default, detailed.)
    if (back?.style !== (j.style ?? 'detailed')) bad.push({ case: j.course, field: 'style', over: 1 });
    for (const k of ['x', 'z', 'y', 'yaw', 'odo', 'fuel']) if (Math.abs((back?.[k] ?? 0) - (j[k] ?? 0)) > 0.06) bad.push({ case: j.course, field: k, got: back?.[k], over: 1 });
    if (JSON.stringify(back?.garages ?? []) !== JSON.stringify(j.garages ?? [])) bad.push({ case: j.course, field: 'garages', over: 1 });
    // Pasted with spaces and line breaks around it, or inside a WhatsApp message: still fine.
    samples++;
    if (!s.decodeCode(`My save:\n ${code} \n`)) bad.push({ case: j.course, field: 'pasted in a message', over: 1 });
    // Any one character changed, or the code cut short: refused.
    for (let i = 4; i < code.length; i++) {
      const c = code[i] === 'A' ? 'B' : 'A';
      samples++;
      if (s.decodeCode(code.slice(0, i) + c + code.slice(i + 1))) bad.push({ case: j.course, field: `char ${i} changed, still accepted`, over: 1 });
    }
    for (const n of [1, 5, 20]) {
      samples++;
      if (s.decodeCode(code.slice(0, -n))) bad.push({ case: j.course, field: `cut ${n} short, still accepted`, over: 1 });
    }
  }
  // A save on the retired old layout (pasirris) opens on the redrawn map,
  // whole, at the same spot; its spot there moves too, the newer one kept.
  samples++;
  const moved = s.normalise({ course: 'pasirris', x: -789.4, z: 1589.2, y: 12.3, yaw: 1, label: 'Our Tampines Hub', savedAt: 5,
    spots: { pasirris: { x: -789.4, z: 1589.2, yaw: 1, label: 'Our Tampines Hub', savedAt: 5 }, whole: { x: 1, z: 2, yaw: 0, label: 'old preview', savedAt: 3 }, eastcoast: { x: 7, z: 8, yaw: 0, label: '', savedAt: 4 } } });
  if (!moved || moved.course !== 'whole' || moved.x !== -789.4 || moved.z !== 1589.2 || moved.y !== 12.3) bad.push({ field: 'old-layout save opens on whole at the same spot', got: moved && [moved.course, moved.x, moved.z], over: 1 });
  if (moved?.spots?.whole?.label !== 'Our Tampines Hub' || moved?.spots?.pasirris || moved?.spots?.eastcoast?.x !== 7) bad.push({ field: 'old-layout spot moves to whole, newer kept, others kept', got: moved?.spots, over: 1 });
  samples++;
  const linked = s.decodeCode(s.encodeCode({ course: 'pasirris', x: 3, z: 4, yaw: 0, label: '', odo: 0, savedAt: 1795000000000, backupOdo: 0, backupAt: 0 }));
  if (linked?.course !== 'whole' || linked.x !== 3 || linked.z !== 4) bad.push({ field: 'old-layout save code opens on whole', got: linked?.course, over: 1 });
  // The save from before this change (camp only).
  samples++;
  const old = s.normalise({ course: 'eastcoast', camp: 'g', label: 'Camp Area G', x: 5, z: 6, yaw: 1, style: 'detailed', savedAt: 1 });
  if (!old || old.x !== 5 || old.camp !== 'g' || old.odo !== 0) bad.push({ field: 'old camp save', over: 1 });
  return { samples, bad: bad.length, worst: bad.slice(0, 12), unit: '' };
};

window.__checkAutosave = () => {
  const g = window.game;
  const p = g.car.mesh.position;
  // Your place on another drive (a camp on Ubin, say) must survive a save here.
  (g.journey.spots ??= {}).ubintrail = { x: 1, z: 2, yaw: 0, label: 'Endut Senin camp', camp: 'endut', savedAt: 1 };
  const ok = g.autosave();
  const j = g.save.loadJourney();
  const off = j ? Math.hypot(j.x - p.x, j.z - p.z) : 999;
  const bad = [];
  if (!ok) bad.push({ field: 'could not write', over: 999 });
  if (off > 0.5) bad.push({ field: 'saved spot', x: j?.x, z: j?.z, over: +off.toFixed(2) });
  const course = new URLSearchParams(location.search).get('course');
  if (j && j.course !== course) bad.push({ field: 'course', got: j.course, over: 1 });
  if (j && j.course !== 'ubintrail' && j.spots?.ubintrail?.camp !== 'endut') bad.push({ field: 'the place on another drive was lost', over: 1 });
  if (j && Math.hypot((j.spots?.[course]?.x ?? 1e9) - p.x, (j.spots?.[course]?.z ?? 1e9) - p.z) > 0.5) bad.push({ field: 'this drive\'s own place', over: 1 });
  delete g.journey.spots.ubintrail;
  g.autosave();
  return { samples: 1, bad: bad.length, worst: bad, unit: 'm' };
};
