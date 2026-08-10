const OUTPUT_LAYOUT_WIDTH = Object.freeze({ mono: 1, stereo: 2, stereoLtRt: 2, '5.1': 6 });

/* A saved/export layout must never claim more channels than its buses can
 * supply.  This pure repair is shared by project-load normalization and bus
 * resize transitions, so legacy malformed projects cannot bypass the UI path
 * and fail only when Electron compiles the delivery plan. */
function repairAudioExportStreams(rawStreams) {
  const streams = Array.isArray(rawStreams) ? rawStreams : [];
  const reservedIds = new Set(streams.map(stream => stream?.id).filter(Boolean));
  const emittedIds = new Set();
  const uniqueGeneratedId = base => {
    let index = 1;
    let id = `${base}-mono-${index}`;
    while (reservedIds.has(id) || emittedIds.has(id)) id = `${base}-mono-${++index}`;
    emittedIds.add(id);
    return id;
  };
  const withoutMisleadingName = stream => {
    const { name, ...rest } = stream || {};
    return rest;
  };

  const repaired = [];
  for (const stream of streams) {
    const busIds = Array.isArray(stream?.busIds) ? stream.busIds : [];
    if (!busIds.length) continue;
    const expected = OUTPUT_LAYOUT_WIDTH[stream?.layout];
    if (expected === busIds.length) {
      repaired.push(stream);
      if (stream.id) emittedIds.add(stream.id);
      continue;
    }
    const base = withoutMisleadingName(stream);
    if (busIds.length === 1) {
      repaired.push({ ...base, layout: 'mono', busIds: [busIds[0]] });
      if (base.id) emittedIds.add(base.id);
      continue;
    }
    if (busIds.length === 2) {
      repaired.push({ ...base, layout: 'stereo', busIds: busIds.slice() });
      if (base.id) emittedIds.add(base.id);
      continue;
    }
    busIds.forEach((busId, index) => {
      const id = index === 0 && base.id ? base.id : uniqueGeneratedId(base.id || 'out');
      emittedIds.add(id);
      repaired.push({ ...base, id, layout: 'mono', busIds: [busId] });
    });
  }
  return repaired;
}

export { OUTPUT_LAYOUT_WIDTH, repairAudioExportStreams };
