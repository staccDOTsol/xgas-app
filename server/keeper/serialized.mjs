/** Serializes writes from one hot wallet on one chain until each receipt settles. */
export function createSerialExecutor() {
  let tail = Promise.resolve();
  return async (operation) => {
    const previous = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  };
}
