// Packed production WebGPU frame recorder. The host reads exactly one ArrayBuffer per frame.
(host) => {
  if (!host || !host.device || !host.queue) return null;
  const device = host.device;
  const queue = host.queue;
  const magic = 0x544e4652;
  const version = 2;
  // Production selects its transport at complete frame boundaries, without a game setting.
  // Explicit booleans remain internal reference arms for transport tests and profiling.
  const automaticPlans = host.compiledFramePlans === undefined;
  let planMode = host.compiledFramePlans === true;
  const frameScopedIds = automaticPlans || planMode;
  // Do not pay to retain tiny frames or mostly-upload payloads. Two equal-sized frames qualify
  // for a probe; failed probes back off so churn cannot cause continuous capture/diff work.
  const minPlanOps = 128;
  const maxBytesPerPlanOp = 128;
  const retryFrames = 32;
  let candidateOps = 0;
  let candidateBytes = 0;
  let candidateFrames = 0;
  let planMisses = 0;
  let retryAfter = 0;
  const planVersion = 3;
  const planCapture = 1;
  const planPatch = 2;
  // Mirrors FramePlanState::maxBytes in src/webgpu/bindings_state.h; the unit lane reads both and
  // fails when they drift, because a mirror that quietly disagrees turns into a hard frame failure
  // at runtime instead of the v2 fallback it is meant to trigger.
  const maxPlanBytes = 32 << 20;
  // The widest record any reusable opcode has — eight values — plus one slot recording how many
  // the site passed, which is what makes a shape change a mismatch rather than a coincidence.
  const kValueStride = 9;
  // Above this many rewritten bytes a frame is cheaper to send as a capture than to diff and apply.
  const kCaptureWhenRewrittenBytes = 1 << 16;
  // The arena starts behind a header either way: a v2 packet's 16 bytes, or the 24 a v3 packet needs
  // so a frame that cannot be patched can be handed over as a capture without copying it.
  let headerBytes = planMode ? 24 : 16;
  let storage = new ArrayBuffer(headerBytes + (1 << 20));
  let view = new DataView(storage);
  let arenaBytes = new Uint8Array(storage);
  let arenaWords = new Uint32Array(storage);
  let cursor = headerBytes;
  let opCount = 0;
  // Resource ids are assigned once, at creation, and never reused. Encoder, pass and command
  // buffer ids are per-*frame*: they restart every frame so a frame's records are the same bytes
  // as the last frame's whenever nothing moved, which is what makes a retained plan worth having.
  // `frameSerial` is what keeps that honest — a wrapper from an earlier frame fails loudly instead
  // of naming whatever object inherited its id in this one.
  let frameId = 0;
  let frameSerial = 0;
  let retained = [];
  // The retained plan: the frame the host holds, as bytes plus its record layout. Every record is
  // compared against it while the frame records, so a record whose values did not move is neither
  // written nor sent. `spare` is the buffer the next capture assembles into, which then *becomes*
  // the plan; a capture swaps the two, so a steady frame allocates nothing.
  let plan = null;
  let planBytes = null;
  let planWords = null;
  let planSequence = 0;
  let hostEpoch = -1;
  let spare = null;
  let captureMode = false;
  // Once a mapAsync drain splits a frame, every remaining piece stays v2 until its boundary.
  let splitFrame = false;
  // The records that moved this frame, as flat [plan index, arena offset, bytes] triples. Records
  // the plan already holds are absent, and nothing else in the frame has to remember them.
  const changed = [];
  let changedCount = 0;
  // How many bytes this frame rewrote, which is what decides between a patch and a capture.
  let writtenBytes = 0;
  let packet = new ArrayBuffer(0);
  let packetView = new DataView(packet);
  let packetBytes = new Uint8Array(packet);
  // The stream can only be cut where nothing is half-written: no command encoder or pass open,
  // no finished command buffer still unsubmitted. `openObjects` counts exactly those, and
  // `safeCursor`/`safeOpCount` remember the last byte where it was zero. `buffer.mapAsync` cuts
  // there, so work the game already handed to `queue.submit` reaches the GPU before the map
  // reports it done.
  let openObjects = 0;
  let safeCursor = headerBytes;
  let safeOpCount = 0;
  // Records the next frame into `buffer`, with the views that go with it. A capture handed over from
  // the arena swaps the two buffers, so this is a rotation and not an allocation.
  const useArena = (buffer) => {
    storage = buffer;
    view = new DataView(storage);
    arenaBytes = new Uint8Array(storage);
    arenaWords = new Uint32Array(storage);
  };
  const ensure = (n) => {
    if (cursor + n <= storage.byteLength) return;
    let size = storage.byteLength * 2;
    while (cursor + n > size) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(new Uint8Array(storage, 0, cursor));
    storage = next;
    view = new DataView(storage);
    arenaBytes = new Uint8Array(storage);
    arenaWords = new Uint32Array(storage);
  };
  const u32 = (v) => {
    ensure(4);
    view.setUint32(cursor, v >>> 0, true);
    cursor += 4;
  };
  const f64 = (v) => {
    ensure(8);
    view.setFloat64(cursor, Number(v), true);
    cursor += 8;
  };
  const raw = (v) => {
    ensure(v.byteLength + 7);
    new Uint8Array(storage, cursor, v.byteLength).set(v);
    cursor += v.byteLength;
    while (cursor & 7) view.setUint8(cursor++, 0);
  };
  // Every value that decides a record's bytes, remembered the moment the record is recorded, so the
  // next frame can ask "is this the same record?" without encoding it again. Two parallel arrays
  // keep the check to a handful of loads: one identity per record index, its values behind it.
  let planCodes = new Int32Array(0);
  let planValues = new Float64Array(0);
  // Only the immediately following successful emit may publish this prepared snapshot.
  let snapshotIndex = -1;
  // The one call a record site makes before it encodes: true means the plan already holds this
  // record, so it is neither written nor sent. False records its values for the next frame to
  // compare. Reading `arguments` directly keeps both the decision and the snapshot allocation-free,
  // and a record wider than the block simply declines to be reused.
  const growSnapshot = (index) => {
    let size = planCodes.length || 1024;
    while (size <= index) size *= 2;
    const codes = new Int32Array(size);
    codes.set(planCodes);
    planCodes = codes;
    const values = new Float64Array(size * kValueStride);
    values.set(planValues);
    planValues = values;
  };
  function reusable(code) {
    // biome-ignore lint/style/noArguments: read by index only, never handed to an array method, and a rest array here would allocate on every record of every frame
    const values = arguments;
    const count = values.length - 1;
    const index = opCount;
    snapshotIndex = -1;
    if (count > kValueStride - 1) return false;
    if (index >= planCodes.length) growSnapshot(index);
    const at = index * kValueStride;
    if (
      !captureMode &&
      plan !== null &&
      planCodes[index] === code &&
      planValues[at + kValueStride - 1] === count
    ) {
      let same = true;
      for (let i = 0; i < count; i += 1) {
        if (planValues[at + i] !== values[i + 1]) {
          same = false;
          break;
        }
      }
      if (same) return true;
    }
    // Coercion can throw while filling a Float64Array. Never leave a valid signature for
    // values that were only partly copied, or for a record that failed to encode afterwards.
    planCodes[index] = 0;
    for (let i = 0; i < count; i += 1) planValues[at + i] = values[i + 1];
    planValues[at + kValueStride - 1] = count;
    planCodes[index] = code;
    snapshotIndex = index;
    return false;
  }
  const reuseRecord = (openDelta) => {
    opCount += 1;
    if (openDelta) openObjects += openDelta;
    if (openObjects === 0) {
      safeCursor = cursor;
      safeOpCount = opCount;
    }
  };
  const recordChanged = (index, offset, bytes) => {
    const at = changedCount * 3;
    changed[at] = index;
    changed[at + 1] = offset;
    changed[at + 2] = bytes;
    changedCount += 1;
  };
  const emit = (code, write, openDelta) => {
    const start = cursor;
    const retainedStart = retained.length;
    if (planMode) {
      // Wide/variable records bypass reusable(), so any older signature at this slot is stale.
      if (snapshotIndex !== opCount) planCodes[opCount] = 0;
      snapshotIndex = -1;
    }
    ensure(8);
    u32(code);
    u32(0);
    try {
      write();
    } catch (error) {
      cursor = start;
      retained.length = retainedStart;
      if (planMode) {
        planCodes[opCount] = 0;
        captureMode = true;
      }
      throw error;
    }
    while (cursor & 7) {
      ensure(1);
      view.setUint8(cursor++, 0);
    }
    view.setUint32(start + 4, cursor - start, true);
    if (planMode) {
      // A record whose opcode or length does not match the plan's at this index is a frame the host
      // cannot patch, so everything from here is recorded whole and sent as a capture.
      const planned = plan === null || captureMode ? null : plan.records;
      if (planned !== null && (planned[opCount * 3 + 1] !== code || planned[opCount * 3 + 2] !== cursor - start))
        captureMode = true;
      recordChanged(opCount, start, cursor - start);
      writtenBytes += cursor - start;
    }
    opCount += 1;
    if (openDelta) openObjects += openDelta;
    if (openObjects === 0) {
      safeCursor = cursor;
      safeOpCount = opCount;
    }
  };
  const resourceId = (v, n, label) => {
    if (!Number.isSafeInteger(n) || n <= 0)
      throw new TypeError(`frame op stream: ${label} has no numeric id`);
    retained.push(v);
    return n;
  };
  const bufferId = (v) => resourceId(v, v?._bufferId, "buffer");
  const textureId = (v) => resourceId(v, v?._textureId, "texture");
  const textureViewId = (v) => resourceId(v, v?._textureViewId, "texture view");
  const pipelineId = (v, label = "pipeline") => resourceId(v, v?._pipelineId, label);
  const bindGroupId = (v) => resourceId(v, v?._bindGroupId, "bind group");
  const renderBundleId = (v) => resourceId(v, v?._renderBundleId, "render bundle");
  const commandBufferId = (v) => {
    if (frameScopedIds && v?.[wireIdKey] !== frameSerial)
      throw new TypeError("frame op stream: stale command buffer from an earlier frame");
    return resourceId(v, v?.__tnCommandBufferId, "command buffer");
  };
  const opt = (v, fallback) => (v === undefined ? fallback : v);
  const offsets = (v) => {
    const n = v == null ? 0 : v.length;
    u32(n);
    for (let i = 0; i < n; i++) u32(v[i]);
  };
  const extent = (v) => {
    if (Array.isArray(v)) {
      u32(v[0]);
      u32(opt(v[1], 1));
      u32(opt(v[2], 1));
    } else {
      u32(v.width);
      u32(opt(v.height, 1));
      u32(opt(v.depthOrArrayLayers, 1));
    }
  };
  const textureCopy = (c) => {
    u32(textureId(c.texture));
    u32(opt(c.mipLevel, 0));
    const o = opt(c.origin, {});
    if (Array.isArray(o)) {
      u32(o[0]);
      u32(opt(o[1], 0));
      u32(opt(o[2], 0));
    } else {
      u32(opt(o.x, 0));
      u32(opt(o.y, 0));
      u32(opt(o.z, 0));
    }
    u32(c.aspect === "depth-only" ? 1 : c.aspect === "stencil-only" ? 2 : 0);
  };
  const uploadRange = (buffer, base, length, unit, dataOffset, size) => {
    const start = opt(dataOffset, 0) * unit;
    const bytes = size === undefined ? length - start : size * unit;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(bytes) ||
      start < 0 ||
      bytes < 0 ||
      start + bytes > length
    )
      throw new RangeError("frame op stream: upload range exceeds source view");
    return new Uint8Array(buffer, base + start, bytes);
  };
  const uploadView1 = (data, dataOffset, size) =>
    uploadRange(data.buffer, data.byteOffset, data.byteLength, 1, dataOffset, size);
  const uploadView2 = (data, dataOffset, size) =>
    uploadRange(data.buffer, data.byteOffset, data.byteLength, 2, dataOffset, size);
  const uploadView4 = (data, dataOffset, size) =>
    uploadRange(data.buffer, data.byteOffset, data.byteLength, 4, dataOffset, size);
  const uploadView8 = (data, dataOffset, size) =>
    uploadRange(data.buffer, data.byteOffset, data.byteLength, 8, dataOffset, size);
  const uploadDataView = (data, dataOffset, size) =>
    uploadRange(data.buffer, data.byteOffset, data.byteLength, 1, dataOffset, size);
  const isView1 = (data) =>
    data instanceof Uint8Array || data instanceof Uint8ClampedArray || data instanceof Int8Array;
  const isView2 = (data) =>
    data instanceof Uint16Array ||
    data instanceof Int16Array ||
    (typeof Float16Array !== "undefined" && data instanceof Float16Array);
  const isView4 = (data) =>
    data instanceof Uint32Array || data instanceof Int32Array || data instanceof Float32Array;
  const isView8 = (data) =>
    data instanceof BigUint64Array || data instanceof BigInt64Array || data instanceof Float64Array;
  const upload = (data, dataOffset, size) => {
    if (data instanceof ArrayBuffer)
      return uploadRange(data, 0, data.byteLength, 1, dataOffset, size);
    if (isView1(data)) return uploadView1(data, dataOffset, size);
    if (isView2(data)) return uploadView2(data, dataOffset, size);
    if (isView4(data)) return uploadView4(data, dataOffset, size);
    if (isView8(data)) return uploadView8(data, dataOffset, size);
    if (data instanceof DataView) return uploadDataView(data, dataOffset, size);
    throw new TypeError("frame op stream: upload source is not an ArrayBuffer or view");
  };
  // GPU timestamps around a pass. Written as a trailing optional block so the record stays the
  // same shape for the passes that ask for none — which is every pass in a shipped frame until a
  // profiler asks otherwise. A query set is named by id, never by handle: the stream carries ids.
  const timestampWrites = (t) => {
    if (!t || !t.querySet) {
      u32(0);
      return;
    }
    const id = t.querySet._querySetId;
    if (typeof id !== "number")
      throw new TypeError("frame op stream: timestampWrites.querySet is not a GPUQuerySet");
    u32(1);
    u32(id);
    u32(t.beginningOfPassWriteIndex === undefined ? 0xffffffff : t.beginningOfPassWriteIndex);
    u32(t.endOfPassWriteIndex === undefined ? 0xffffffff : t.endOfPassWriteIndex);
  };
  const renderPassIdKey = Symbol("frameOpRenderPassId");
  const computePassIdKey = Symbol("frameOpComputePassId");
  const wireIdKey = Symbol("frameOpWireSerial");
  // Pass, encoder and command buffer ids restart every frame, so a holder from an earlier frame
  // would name whatever object inherited its id. The serial makes that fail loudly instead.
  const receiverId = (receiver, key, label) => {
    const id = receiver?.[key];
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new TypeError(`frame op stream: no ${label} receiver`);
    // Automatic fallback still uses frame-local ids: wrappers must not alias a later frame's
    // objects merely because that later frame chose a different transport.
    if (frameScopedIds && receiver[wireIdKey] !== frameSerial)
      throw new TypeError(`frame op stream: stale ${label} from an earlier frame`);
    return id;
  };
  const renderPassDepthSlice = (attachment) => {
    const value = attachment.depthSlice === undefined ? 0xffffffff : attachment.depthSlice;
    if (
      attachment.depthSlice !== undefined &&
      (!Number.isSafeInteger(value) || value < 0 || value >= 0xffffffff)
    )
      throw new RangeError("frame op stream: depthSlice must be a non-negative integer");
    return value;
  };
  const renderPassPrototype = {
    setPipeline(p) {
      const passId = receiverId(this, renderPassIdKey, "render pass");
      if (planMode && reusable(4, passId, pipelineId(p, "render pipeline"))) {
        reuseRecord(0);
        return;
      }
      emit(4, () => {
        u32(passId);
        u32(pipelineId(p, "render pipeline"));
      });
    },
    setBindGroup(i, g, o) {
      const passId = receiverId(this, renderPassIdKey, "render pass");
      // Four dynamic offsets are the widest the snapshot holds; a wider list is written every frame
      // instead of compared against a snapshot that could not carry it.
      const widest = o == null ? 0 : o.length;
      if (
        widest <= 4 &&
        planMode &&
        reusable(5, passId, i, bindGroupId(g), widest, o?.[0] ?? 0, o?.[1] ?? 0, o?.[2] ?? 0, o?.[3] ?? 0)
      ) {
        reuseRecord(0);
        return;
      }
      emit(5, () => {
        u32(passId);
        u32(i);
        u32(bindGroupId(g));
        offsets(o);
      });
    },
    setVertexBuffer(s, b, o, z) {
      const passId = receiverId(this, renderPassIdKey, "render pass");
      if (planMode && reusable(6, passId, s, bufferId(b), opt(o, 0), opt(z, -1))) {
        reuseRecord(0);
        return;
      }
      emit(6, () => {
        u32(passId);
        u32(s);
        u32(bufferId(b));
        f64(opt(o, 0));
        f64(opt(z, -1));
      });
    },
    setIndexBuffer(b, f, o, z) {
      const passId = receiverId(this, renderPassIdKey, "render pass");
      // The format goes in as a number, never a boolean: the snapshot holds numbers, and `1 !== true`
      // would make every index-buffer record look changed for the rest of the run.
      if (planMode && reusable(7, passId, bufferId(b), f === "uint32" ? 1 : 0, opt(o, 0), opt(z, -1))) {
        reuseRecord(0);
        return;
      }
      emit(7, () => {
        u32(passId);
        u32(bufferId(b));
        u32(f === "uint32");
        f64(opt(o, 0));
        f64(opt(z, -1));
      });
    },
    draw(a, b, c, d) {
      const passId = receiverId(this, renderPassIdKey, "render pass");
      if (planMode && reusable(8, passId, a, opt(b, 1), opt(c, 0), opt(d, 0))) {
        reuseRecord(0);
        return;
      }
      emit(8, () => {
        u32(passId);
        u32(a);
        u32(opt(b, 1));
        u32(opt(c, 0));
        u32(opt(d, 0));
      });
    },
    drawIndexed(a, b, c, d, e) {
      const passId = receiverId(this, renderPassIdKey, "render pass");
      if (planMode && reusable(9, passId, a, opt(b, 1), opt(c, 0), opt(d, 0), opt(e, 0))) {
        reuseRecord(0);
        return;
      }
      emit(9, () => {
        u32(passId);
        u32(a);
        u32(opt(b, 1));
        u32(opt(c, 0));
        u32(opt(d, 0));
        u32(opt(e, 0));
      });
    },
    drawIndirect(b, o) {
      const passId = receiverId(this, renderPassIdKey, "render pass");
      if (planMode && reusable(10, passId, bufferId(b), o)) {
        reuseRecord(0);
        return;
      }
      emit(10, () => {
        u32(passId);
        u32(bufferId(b));
        f64(o);
      });
    },
    drawIndexedIndirect(b, o) {
      const passId = receiverId(this, renderPassIdKey, "render pass");
      if (planMode && reusable(11, passId, bufferId(b), o)) {
        reuseRecord(0);
        return;
      }
      emit(11, () => {
        u32(passId);
        u32(bufferId(b));
        f64(o);
      });
    },
    setViewport(...a) {
      const passId = receiverId(this, renderPassIdKey, "render pass");
      if (a.length === 6 && planMode && reusable(12, passId, a[0], a[1], a[2], a[3], a[4], a[5])) {
        reuseRecord(0);
        return;
      }
      emit(12, () => {
        u32(passId);
        for (const v of a) f64(v);
      });
    },
    setScissorRect(...a) {
      const passId = receiverId(this, renderPassIdKey, "render pass");
      if (a.length === 4 && planMode && reusable(13, passId, a[0], a[1], a[2], a[3])) {
        reuseRecord(0);
        return;
      }
      emit(13, () => {
        u32(passId);
        for (const v of a) u32(v);
      });
    },
    setBlendConstant(c) {
      const passId = receiverId(this, renderPassIdKey, "render pass");
      const listed = Array.isArray(c) || ArrayBuffer.isView(c);
      if (
        planMode &&
        reusable(
          14,
          passId,
          listed ? c[0] : c.r,
          listed ? c[1] : c.g,
          listed ? c[2] : c.b,
          listed ? c[3] : c.a,
        )
      ) {
        reuseRecord(0);
        return;
      }
      emit(14, () => {
        u32(passId);
        if (Array.isArray(c) || ArrayBuffer.isView(c)) {
          f64(c[0]);
          f64(c[1]);
          f64(c[2]);
          f64(c[3]);
        } else {
          f64(c.r);
          f64(c.g);
          f64(c.b);
          f64(c.a);
        }
      });
    },
    setStencilReference(r) {
      const passId = receiverId(this, renderPassIdKey, "render pass");
      if (planMode && reusable(15, passId, r)) {
        reuseRecord(0);
        return;
      }
      emit(15, () => {
        u32(passId);
        u32(r);
      });
    },
    executeBundles(a) {
      const passId = receiverId(this, renderPassIdKey, "render pass");
      emit(16, () => {
        u32(passId);
        u32(a.length);
        for (const b of a) u32(renderBundleId(b));
      });
    },
    end() {
      const passId = receiverId(this, renderPassIdKey, "render pass");
      if (planMode && reusable(17, passId)) {
        reuseRecord(-1);
        return;
      }
      emit(17, () => u32(passId), -1);
    },
  };
  const computePassPrototype = {
    setPipeline(p) {
      const passId = receiverId(this, computePassIdKey, "compute pass");
      if (planMode && reusable(19, passId, pipelineId(p, "compute pipeline"))) {
        reuseRecord(0);
        return;
      }
      emit(19, () => {
        u32(passId);
        u32(pipelineId(p, "compute pipeline"));
      });
    },
    setBindGroup(i, g, o) {
      const passId = receiverId(this, computePassIdKey, "compute pass");
      const widest = o == null ? 0 : o.length;
      if (
        widest <= 4 &&
        planMode &&
        reusable(20, passId, i, bindGroupId(g), widest, o?.[0] ?? 0, o?.[1] ?? 0, o?.[2] ?? 0, o?.[3] ?? 0)
      ) {
        reuseRecord(0);
        return;
      }
      emit(20, () => {
        u32(passId);
        u32(i);
        u32(bindGroupId(g));
        offsets(o);
      });
    },
    dispatchWorkgroups(x, y, z) {
      const passId = receiverId(this, computePassIdKey, "compute pass");
      if (planMode && reusable(21, passId, x, opt(y, 1), opt(z, 1))) {
        reuseRecord(0);
        return;
      }
      emit(21, () => {
        u32(passId);
        u32(x);
        u32(opt(y, 1));
        u32(opt(z, 1));
      });
    },
    dispatchWorkgroupsIndirect(b, o) {
      const passId = receiverId(this, computePassIdKey, "compute pass");
      if (planMode && reusable(35, passId, bufferId(b), o)) {
        reuseRecord(0);
        return;
      }
      emit(35, () => {
        u32(passId);
        u32(bufferId(b));
        f64(o);
      });
    },
    end() {
      const passId = receiverId(this, computePassIdKey, "compute pass");
      if (planMode && reusable(22, passId)) {
        reuseRecord(-1);
        return;
      }
      emit(22, () => u32(passId), -1);
    },
  };
  const renderPass = (encoderId, descriptor) => {
    const passId = ++frameId;
    emit(3, () => {
      u32(encoderId);
      u32(passId);
      const colors = descriptor.colorAttachments || [];
      u32(colors.length);
      for (const c of colors) {
        if (!c) throw new TypeError("frame op stream: null color attachment unsupported");
        u32(textureViewId(c.view));
        u32(c.resolveTarget ? textureViewId(c.resolveTarget) : 0);
        u32(c.loadOp === "load" ? 1 : 0);
        u32(c.storeOp === "discard" ? 1 : 0);
        const x = opt(c.clearValue, {});
        if (Array.isArray(x)) {
          f64(x[0]);
          f64(x[1]);
          f64(x[2]);
          f64(x[3]);
        } else {
          f64(opt(x.r, 0));
          f64(opt(x.g, 0));
          f64(opt(x.b, 0));
          f64(opt(x.a, 0));
        }
        u32(renderPassDepthSlice(c));
      }
      const d = descriptor.depthStencilAttachment;
      u32(d ? 1 : 0);
      if (d) {
        u32(textureViewId(d.view));
        f64(opt(d.depthClearValue, 1));
        u32(d.depthLoadOp === "load" ? 1 : 0);
        u32(d.depthStoreOp === "discard" ? 1 : 0);
        u32(opt(d.depthReadOnly, false));
        u32(opt(d.stencilClearValue, 0));
        u32(d.stencilLoadOp === "load" ? 1 : d.stencilLoadOp === "clear" ? 0 : 2);
        u32(d.stencilStoreOp === "store" ? 0 : d.stencilStoreOp === "discard" ? 1 : 2);
        u32(opt(d.stencilReadOnly, false));
      }
      timestampWrites(descriptor.timestampWrites);
    }, 1);
    const pass = Object.create(renderPassPrototype);
    pass[renderPassIdKey] = passId;
    pass[wireIdKey] = frameSerial;
    return pass;
  };
  const computePass = (encoderId, descriptor) => {
    const passId = ++frameId;
    emit(18, () => {
      u32(encoderId);
      u32(passId);
      timestampWrites(descriptor?.timestampWrites);
    }, 1);
    const pass = Object.create(computePassPrototype);
    pass[computePassIdKey] = passId;
    pass[wireIdKey] = frameSerial;
    return pass;
  };
  const encoderIdKey = Symbol("frameOpEncoderId");
  const encoderIdOf = (receiver) => receiverId(receiver, encoderIdKey, "command encoder");
  const commandEncoderPrototype = {
    beginRenderPass(d) {
      return renderPass(encoderIdOf(this), d);
    },
    beginComputePass(d) {
      return computePass(encoderIdOf(this), d);
    },
    copyBufferToBuffer(s, so, d, do_, z) {
      if (
        planMode &&
        reusable(23, encoderIdOf(this), bufferId(s), so, bufferId(d), do_, z)
      ) {
        reuseRecord(0);
        return;
      }
      emit(23, () => {
        u32(encoderIdOf(this));
        u32(bufferId(s));
        f64(so);
        u32(bufferId(d));
        f64(do_);
        f64(z);
      });
    },
    copyBufferToTexture(s, d, z) {
      emit(24, () => {
        u32(encoderIdOf(this));
        u32(bufferId(s.buffer));
        f64(opt(s.offset, 0));
        u32(opt(s.bytesPerRow, 0));
        u32(opt(s.rowsPerImage, 0));
        textureCopy(d);
        extent(z);
      });
    },
    copyTextureToBuffer(s, d, z) {
      emit(25, () => {
        u32(encoderIdOf(this));
        textureCopy(s);
        u32(bufferId(d.buffer));
        f64(opt(d.offset, 0));
        u32(opt(d.bytesPerRow, 0));
        u32(opt(d.rowsPerImage, 0));
        extent(z);
      });
    },
    copyTextureToTexture(s, d, z) {
      emit(26, () => {
        u32(encoderIdOf(this));
        textureCopy(s);
        textureCopy(d);
        extent(z);
      });
    },
    clearBuffer(b, o, z) {
      if (planMode && reusable(27, encoderIdOf(this), bufferId(b), opt(o, 0), opt(z, -1))) {
        reuseRecord(0);
        return;
      }
      emit(27, () => {
        u32(encoderIdOf(this));
        u32(bufferId(b));
        f64(opt(o, 0));
        f64(opt(z, -1));
      });
    },
    resolveQuerySet(querySet, firstQuery, queryCount, destination, destinationOffset) {
      const id = querySet?._querySetId;
      if (typeof id !== "number")
        throw new TypeError("frame op stream: resolveQuerySet needs a GPUQuerySet");
      if (
        planMode &&
        reusable(
          34,
          encoderIdOf(this),
          id,
          firstQuery,
          queryCount,
          bufferId(destination),
          opt(destinationOffset, 0),
        )
      ) {
        reuseRecord(0);
        return;
      }
      emit(34, () => {
        u32(encoderIdOf(this));
        u32(id);
        u32(firstQuery);
        u32(queryCount);
        u32(bufferId(destination));
        f64(opt(destinationOffset, 0));
      });
    },
    finish() {
      const commandId = ++frameId;
      if (planMode && reusable(28, encoderIdOf(this), commandId)) reuseRecord(0);
      else
        emit(28, () => {
          u32(encoderIdOf(this));
          u32(commandId);
        });
      return { __tnCommandBufferId: commandId, [wireIdKey]: frameSerial };
    },
  };
  device.createCommandEncoder = () => {
    const encoderId = ++frameId;
    if (planMode && reusable(2, encoderId)) reuseRecord(1);
    else emit(2, () => u32(encoderId), 1);
    const encoder = Object.create(commandEncoderPrototype);
    encoder[encoderIdKey] = encoderId;
    encoder[wireIdKey] = frameSerial;
    return encoder;
  };
  const wrapDestroy = (resource, readId, opcode) => {
    if (!resource || typeof resource.destroy !== "function") return resource;
    let destroyed = false;
    resource.destroy = () => {
      if (destroyed) return;
      const id = readId(resource);
      emit(opcode, () => u32(id));
      destroyed = true;
    };
    return resource;
  };
  const createBuffer = device.createBuffer.bind(device);
  const createTexture = device.createTexture.bind(device);
  device.createBuffer = (descriptor) => wrapDestroy(createBuffer(descriptor), bufferId, 32);
  device.createTexture = (descriptor) => wrapDestroy(createTexture(descriptor), textureId, 33);
  queue.writeBuffer = (b, o, d, do_, z) => {
    if (!Number.isSafeInteger(o) || o < 0 || o & 3)
      throw new RangeError(
        "frame op stream: writeBuffer offset must be a non-negative multiple of 4",
      );
    const copy = upload(d, do_, z);
    if (copy.byteLength & 3)
      throw new RangeError("frame op stream: writeBuffer size must be a multiple of 4");
    emit(1, () => {
      u32(bufferId(b));
      f64(o);
      u32(copy.byteLength);
      raw(copy);
    });
  };
  // Texel block height of a compressed format (BC, ETC2/EAC: 4; ASTC: its declared height), so the
  // rows a copy reads are block rows. Uncompressed formats are one texel high.
  const blockHeight = (format) => {
    if (typeof format !== "string") return 1;
    if (/^(?:bc\d|etc2|eac)/u.test(format)) return 4;
    const astc = /^astc-\d+x(\d+)-/u.exec(format);
    return astc ? Number(astc[1]) : 1;
  };
  // Only the bytes this copy reads, from `layout.offset` onward, so a caller that points into a
  // larger buffer — three uploads each layer of an array texture as the whole array plus an
  // offset — records one layer, not the whole array once per layer. The last row is bounded by
  // `bytesPerRow`, which covers any block size, and the slice by the source. A layout without
  // `bytesPerRow` is a single-row copy and keeps everything after the offset, as before.
  const textureUploadSlice = (d, data, l, z) => {
    const bytes = upload(data, 0);
    const offset = opt(l.offset, 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.byteLength)
      throw new RangeError("frame op stream: writeTexture offset exceeds source");
    const bytesPerRow = l.bytesPerRow;
    if (bytesPerRow === undefined) return bytes.subarray(offset);
    const height = Array.isArray(z) ? opt(z[1], 1) : opt(z.height, 1);
    const layers = Array.isArray(z) ? opt(z[2], 1) : opt(z.depthOrArrayLayers, 1);
    const rows = Math.ceil(height / blockHeight(d.texture?.format));
    const rowsPerImage = opt(l.rowsPerImage, rows);
    const needed =
      rows === 0 || layers === 0 ? 0 : bytesPerRow * (rowsPerImage * (layers - 1) + rows);
    return bytes.subarray(offset, Math.min(bytes.byteLength, offset + needed));
  };
  queue.writeTexture = (d, data, l, z) => {
    const copy = textureUploadSlice(d, data, l, z);
    emit(30, () => {
      textureCopy(d);
      f64(0);
      u32(opt(l.bytesPerRow, 0));
      u32(opt(l.rowsPerImage, 0));
      extent(z);
      u32(copy.byteLength);
      raw(copy);
    });
  };
  queue.copyExternalImageToTexture = (s, d, z) => {
    const image = s?.source;
    let rgba = image && (image.data || image._data);
    // CanvasTexture sources have live pixels, not an ImageBitmap's stored byte array.
    // Snapshot at enqueue time: later canvas drawing must not change this recorded upload.
    if (!rgba && typeof image?.getContext === "function") {
      const context = image.getContext("2d");
      rgba = context?.getImageData(0, 0, image.width, image.height).data;
    }
    if (!rgba) throw new TypeError("frame op stream: external image has no eager-copy RGBA data");
    const copy = upload(rgba, 0);
    const o = opt(s.origin, {});
    const ox = Array.isArray(o) ? opt(o[0], 0) : opt(o.x, 0);
    const oy = Array.isArray(o) ? opt(o[1], 0) : opt(o.y, 0);
    emit(31, () => {
      u32(image.width);
      u32(image.height);
      u32(ox);
      u32(oy);
      u32(s.flipY ? 1 : 0);
      textureCopy(d);
      extent(z);
      u32(copy.byteLength);
      raw(copy);
    });
  };
  queue.submit = (a) => {
    // A frame submits one command buffer; wider submits are written every frame rather than
    // compared against a snapshot that could not hold them.
    const submitted = planMode && a.length <= 4 ? a.map(commandBufferId) : null;
    if (
      submitted !== null &&
      planMode &&
      reusable(29, a.length, submitted[0] ?? 0, submitted[1] ?? 0, submitted[2] ?? 0, submitted[3] ?? 0)
    ) {
      reuseRecord(-submitted.length);
      return;
    }
    emit(29,
      () => {
        u32(a.length);
        for (const b of a) u32(commandBufferId(b));
      },
      -a.length);
  };
  // ---- compiled frame plans ------------------------------------------------------------------
  // The bytes this frame has to send, as one packet. Everything below runs only in plan mode; the
  // v2 stream is written and handed over by the drain itself.
  const ensurePacket = (n) => {
    if (n <= packet.byteLength) return;
    let size = packet.byteLength || 1 << 16;
    while (n > size) size *= 2;
    const next = new ArrayBuffer(size);
    const nextBytes = new Uint8Array(next);
    nextBytes.set(packetBytes);
    packet = next;
    packetView = new DataView(packet);
    packetBytes = nextBytes;
  };
  // Copies one changed run out of the arena into the packet at `at` and returns the offset after it:
  // one run header (offset and length, both relative to the record) and its bytes.
  const writeRun = (at, recordStart, firstWord, lastWord) => {
    const length = (lastWord - firstWord) * 4;
    ensurePacket(at + 8 + length);
    packetView.setUint32(at, (firstWord - (recordStart >> 2)) * 4, true);
    packetView.setUint32(at + 4, length, true);
    packetBytes.set(arenaBytes.subarray(firstWord * 4, lastWord * 4), at + 8);
    return at + 8 + length;
  };
  // The plan's record layout: a flat [offset, opcode, bytes] list, walked once per capture.
  const planRecords = (body, count) => {
    const records = new Array(count * 3);
    const bodyView = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let at = 0;
    for (let index = 0; index < count; index += 1) {
      const bytes = bodyView.getUint32(at + 4, true);
      records[index * 3] = at;
      records[index * 3 + 1] = bodyView.getUint32(at, true);
      records[index * 3 + 2] = bytes;
      at += bytes;
    }
    return records;
  };
  // A buffer for the next capture: the one the previous plan left behind when it is big enough,
  // which is every capture after the first. A capture swaps the two, so nothing is allocated in a
  // steady state.
  const planBuffer = (bytes) => {
    let buffer = spare;
    spare = null;
    if (buffer === null || buffer.byteLength < bytes) {
      let size = 1 << 20;
      while (size < bytes) size *= 2;
      buffer = new ArrayBuffer(size);
    }
    return buffer;
  };
  // Adopts [headerBytes, end) of `buffer` as the retained plan. Which buffers are free afterwards is
  // the caller's business: an assembled capture frees the old plan's buffer, a capture handed over
  // from the arena does not.
  const adoptPlan = (buffer, end, headerBytes, count) => {
    const body = new Uint8Array(buffer, headerBytes, end - headerBytes);
    planBytes = body;
    planWords = new Uint32Array(buffer, headerBytes, body.byteLength >> 2);
    plan = {
      buffer,
      records: planRecords(body, count),
      count,
      size: body.byteLength,
      sequence: planSequence,
      // The generation the host reported for this capture. It only moves when the host drops the
      // plan, which is exactly when the recorder has to stop patching and capture again.
      epoch: hostEpoch,
    };
  };
  // True when the arena already holds records 0..count-1, in order and back to back: the frame a
  // capture would assemble is sitting there, so handing it over costs a header and nothing else.
  const arenaHoldsFrame = (count) => {
    if (changedCount !== count) return false;
    let at = headerBytes;
    for (let index = 0; index < count; index += 1) {
      if (changed[index * 3] !== index || changed[index * 3 + 1] !== at) return false;
      at += changed[index * 3 + 2];
    }
    return true;
  };
  const discardPlan = () => {
    if (plan !== null) spare = plan.buffer;
    plan = null;
    planBytes = null;
    planWords = null;
    planCodes.fill(0);
    snapshotIndex = -1;
  };
  // The body size of records [0, count): the plan's own sizes for the records it kept, the arena's
  // for the ones that moved.
  const assembledBytes = (count) => {
    const records = plan === null ? null : plan.records;
    let bytes = 0;
    let next = 0;
    for (let index = 0; index < count; index += 1) {
      if (next < changedCount && changed[next * 3] === index) {
        bytes += changed[next * 3 + 2];
        next += 1;
      } else {
        bytes += records[index * 3 + 2];
      }
    }
    return bytes;
  };
  // Assembles records [0, count) behind a header and returns the end offset. A record the plan
  // already held is copied from it, one that moved is copied from the arena, so the frame is back
  // without anything having been kept twice.
  const assemble = (destination, count, headerBytes) => {
    const destinationBytes = new Uint8Array(destination);
    const records = plan === null ? null : plan.records;
    let at = headerBytes;
    let next = 0;
    for (let index = 0; index < count; index += 1) {
      let source;
      let offset;
      let bytes;
      if (next < changedCount && changed[next * 3] === index) {
        source = arenaBytes;
        offset = changed[next * 3 + 1];
        bytes = changed[next * 3 + 2];
        next += 1;
      } else {
        source = planBytes;
        offset = records[index * 3];
        bytes = records[index * 3 + 2];
      }
      destinationBytes.set(source.subarray(offset, offset + bytes), at);
      at += bytes;
    }
    return at;
  };
  // One packet for a whole frame: a v3 capture the host may keep, or the v2 packet a partial drain
  // has to use because a frame cut short must never become the plan.
  const assemblePacket = (count, partial) => {
    const bodyBytes = assembledBytes(count);
    const plain = partial || bodyBytes > maxPlanBytes;
    const packetHeaderBytes = plain ? 16 : 24;
    const buffer = planBuffer(packetHeaderBytes + bodyBytes);
    const end = assemble(buffer, count, packetHeaderBytes);
    const target = new DataView(buffer);
    target.setUint32(0, magic, true);
    target.setUint32(4, plain ? version : planVersion, true);
    target.setUint32(8, end, true);
    if (plain) {
      target.setUint32(12, count, true);
      // Partial drains still need the plan to materialize their tail before invalidation.
      if (!partial) discardPlan();
      return buffer;
    }
    planSequence += 1;
    target.setUint32(12, planCapture, true);
    target.setUint32(16, planSequence, true);
    target.setUint32(20, count, true);
    const previous = plan === null ? null : plan.buffer;
    adoptPlan(buffer, end, packetHeaderBytes, count);
    // The assembled buffer is the plan now, so the buffer the old plan used is free to assemble
    // into next time.
    if (previous !== null && previous !== buffer && previous !== storage) spare = previous;
    return buffer;
  };
  // The packet for a frame whose layout the host already holds: one entry per record that moved and,
  // inside it, only the 8-byte words that moved. Returns null when the delta would carry more bytes
  // than the frame itself, and the caller sends a capture instead.
  const buildPatch = () => {
    const records = plan.records;
    const planWordsLocal = planWords;
    let at = 24;
    let entries = 0;
    for (let moved = 0; moved < changedCount; moved += 1) {
      const index = changed[moved * 3];
      const arenaStart = changed[moved * 3 + 1];
      const recordBytes = changed[moved * 3 + 2];
      const firstWord = (arenaStart >> 2) + 2;
      const lastWord = (arenaStart + recordBytes) >> 2;
      const planFirstWord = (records[index * 3] >> 2) + 2;
      const entryAt = at;
      at += 8;
      let runs = 0;
      let runStart = 0;
      // The record's first two words are its header — opcode and length — and a patch never changes
      // them, so the comparison starts at its payload.
      for (let word = firstWord; word < lastWord; word += 2) {
        const target = planFirstWord + (word - firstWord);
        if (
          arenaWords[word] !== planWordsLocal[target] ||
          arenaWords[word + 1] !== planWordsLocal[target + 1]
        ) {
          if (!runStart) runStart = word;
        } else if (runStart) {
          at = writeRun(at, arenaStart, runStart, word);
          runs += 1;
          runStart = 0;
        }
      }
      if (runStart) {
        at = writeRun(at, arenaStart, runStart, lastWord);
        runs += 1;
      }
      if (!runs) {
        at = entryAt;
        continue;
      }
      packetView.setUint32(entryAt, index, true);
      packetView.setUint32(entryAt + 4, runs, true);
      entries += 1;
      if (at > plan.size + 24) return null;
    }
    ensurePacket(at);
    writePacketHeader(packetView, at, planPatch, planSequence + 1, entries);
    return packet;
  };
  // The plan holds what the host holds, so a patched frame has to be folded back into it: the next
  // frame compares against these bytes.
  const applyChanges = () => {
    for (let moved = 0; moved < changedCount; moved += 1) {
      const target = plan.records[changed[moved * 3] * 3] >> 2;
      const source = changed[moved * 3 + 1] >> 2;
      const words = changed[moved * 3 + 2] >> 2;
      for (let word = 0; word < words; word += 1) planWords[target + word] = arenaWords[source + word];
    }
  };
  const writePacketHeader = (target, bytes, mode, sequence, count) => {
    target.setUint32(0, magic, true);
    target.setUint32(4, planVersion, true);
    target.setUint32(8, bytes, true);
    target.setUint32(12, mode, true);
    target.setUint32(16, sequence, true);
    target.setUint32(20, count, true);
  };
  const resetFrame = () => {
    cursor = headerBytes;
    opCount = 0;
    changedCount = 0;
    writtenBytes = 0;
    openObjects = 0;
    retained = [];
    safeCursor = headerBytes;
    safeOpCount = 0;
    captureMode = false;
    splitFrame = false;
    snapshotIndex = -1;
  };
  // Called only at a real frame boundary, after the returned packet has been materialized.
  // Selection uses counters already collected by recording; the direct path does not scan,
  // hash, copy or retain its packet to decide whether to try plans on the next frame.
  const finishFrame = (bodyBytes, usefulPatch = false) => {
    if (automaticPlans) {
      const eligible =
        !splitFrame &&
        opCount >= minPlanOps &&
        bodyBytes <= maxPlanBytes &&
        bodyBytes <= opCount * maxBytesPerPlanOp;
      let nextMode = planMode;
      if (planMode) {
        planMisses = usefulPatch ? 0 : planMisses + 1;
        // The initial capture gets one grace frame. Repeated captures, near-full patches,
        // upload-heavy frames and partial readbacks are not profitable retained workloads.
        if (!eligible || planMisses >= 2) {
          nextMode = false;
          retryAfter = retryFrames;
          candidateFrames = 0;
        }
      } else if (retryAfter > 0) {
        retryAfter -= 1;
        candidateFrames = 0;
      } else if (eligible) {
        candidateFrames =
          candidateOps === opCount && candidateBytes === bodyBytes ? candidateFrames + 1 : 1;
        candidateOps = opCount;
        candidateBytes = bodyBytes;
        nextMode = candidateFrames >= 2;
      } else {
        candidateFrames = 0;
      }
      if (nextMode !== planMode) {
        discardPlan();
        planMode = nextMode;
        headerBytes = planMode ? 24 : 16;
        planMisses = 0;
        if (!planMode) {
          // A streaming/loading phase must not keep an abandoned retained plan and its
          // snapshots alive indefinitely. The direct recorder only keeps its normal arena.
          spare = null;
          changed.length = 0;
          planCodes = new Int32Array(0);
          planValues = new Float64Array(0);
          packet = new ArrayBuffer(0);
          packetView = new DataView(packet);
          packetBytes = new Uint8Array(packet);
        }
      }
    }
    resetFrame();
    if (frameScopedIds) {
      frameSerial += 1;
      frameId = 0;
    }
  };
  // `partial` drains only up to the last clean cut, leaving a half-recorded encoder to keep
  // recording; the host passes it from `buffer.mapAsync`. The frame boundary passes nothing and
  // drains everything, exactly as before. `planEpoch` is the retained-plan generation the host
  // reports; when it is not the one this recorder captured against, the plan is gone over there and
  // the frame is sent as a capture instead of as a patch.
  const drain = (partial, planEpoch) => {
    const ops = partial ? safeOpCount : opCount;
    if (!ops) {
      // A fully consumed partial frame still has a real boundary: expire its wire wrappers.
      if (frameScopedIds && !partial) finishFrame(0);
      return null;
    }
    hostEpoch = planEpoch;
    if (planMode) {
      if (partial) {
        // Materialize before dropping the plan: even the unfinished tail may contain reused
        // records absent from the arena. The returned prefix must not be replayed a second time.
        const end = 16 + assembledBytes(ops);
        const frame = assemblePacket(opCount, true);
        const target = new DataView(frame);
        const tailBytes = target.getUint32(8, true) - end;
        target.setUint32(8, end, true);
        target.setUint32(12, ops, true);
        cursor = 0;
        ensure(tailBytes);
        arenaBytes.set(new Uint8Array(frame, end, tailBytes));
        cursor = tailBytes;
        opCount -= ops;
        changedCount = 0;
        writtenBytes = tailBytes;
        for (let index = 0, at = 0; index < opCount; index += 1) {
          const bytes = view.getUint32(at + 4, true);
          recordChanged(index, at, bytes);
          at += bytes;
        }
        discardPlan();
        safeCursor = 0;
        safeOpCount = 0;
        captureMode = true;
        splitFrame = true;
        // Keep openObjects, retained resources and wire ids until the real frame boundary.
        return frame;
      }
      let frame = null;
      let usefulPatch = false;
      // A frame that rewrote most of itself is cheaper to send whole than to diff, apply and carry:
      // the patch path would touch those bytes three times over, and the host already holds the
      // layout, so a capture costs one pass and keeps the plan in step with it. The floor is what
      // keeps that trade away from small frames, whose patch is cheaper than a capture's copy and
      // whose bytes are the thing this transport exists to cut.
      const mostlyNew =
        plan !== null && writtenBytes * 2 > plan.size && writtenBytes > kCaptureWhenRewrittenBytes;
      if (
        !captureMode &&
        !mostlyNew &&
        plan !== null &&
        planEpoch === plan.epoch &&
        opCount === plan.count
      ) {
        frame = buildPatch();
        if (frame !== null) {
          usefulPatch =
            packetView.getUint32(8, true) * 2 <= plan.size &&
            changedCount * 2 <= opCount &&
            writtenBytes * 2 <= plan.size;
          applyChanges();
          plan.sequence = planSequence + 1;
          planSequence += 1;
        }
      }
      const arenaBodyBytes = cursor - headerBytes;
      if (
        frame === null &&
        !splitFrame &&
        !captureMode &&
        arenaBodyBytes <= maxPlanBytes &&
        arenaHoldsFrame(opCount)
      ) {
        // Every record of this frame is already in the arena, in order, so a capture is a header
        // written in front of them: the packet is the arena, and the buffer the old plan used
        // becomes the next frame's arena.
        frame = storage;
        planSequence += 1;
        writePacketHeader(view, cursor, planCapture, planSequence, opCount);
        const previous = plan === null ? null : plan.buffer;
        adoptPlan(frame, cursor, headerBytes, opCount);
        if (previous !== null && previous !== storage) useArena(previous);
        else useArena(new ArrayBuffer(storage.byteLength));
        finishFrame(arenaBodyBytes);
        return frame;
      }
      if (frame === null) frame = assemblePacket(opCount, splitFrame);
      const bodyBytes = plan === null ? cursor - headerBytes : plan.size;
      finishFrame(bodyBytes, usefulPatch);
      return frame;
    }
    // The v2 stream is the packet: its records start behind the header and the host reads the whole
    // buffer. A partial drain cuts at the last clean boundary; a frame boundary hands the arena
    // over and starts the next frame, which also restarts the per-frame wire ids both sides assume.
    const end = partial ? safeCursor : cursor;
    view.setUint32(0, magic, true);
    view.setUint32(4, version, true);
    view.setUint32(8, end, true);
    view.setUint32(12, ops, true);
    const frame = storage;
    if (partial) splitFrame = true;
    if (end < cursor) {
      // The host reads `frame` after this returns, so the bytes it was handed must not move: the
      // still-recording tail continues in a buffer of its own.
      const tail = new Uint8Array(storage, end, cursor - end);
      const next = new ArrayBuffer(storage.byteLength);
      new Uint8Array(next, 16, tail.byteLength).set(tail);
      useArena(next);
      cursor = 16 + tail.byteLength;
      opCount -= ops;
      safeCursor = 16;
      safeOpCount = 0;
      return frame;
    }
    if (!partial) {
      finishFrame(end - 16);
    } else {
      // Consuming the submitted prefix is not permission to change modes or recycle ids.
      cursor = 16;
      opCount = 0;
      openObjects = 0;
      retained = [];
      safeCursor = 16;
      safeOpCount = 0;
    }
    return frame;
  };
  Object.defineProperty(drain, "pendingOps", { get: () => opCount > 0 });
  return drain;
};
