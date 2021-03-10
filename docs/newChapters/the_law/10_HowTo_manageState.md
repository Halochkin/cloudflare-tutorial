# HowTo: manage state?

In this article we will describe how you can use regulators to manage state *as an afterthought*. It is wonderful.

```javascript
function stateManager(...originals) {
  const trace = [];
  let count = 0;
  const regulators = originals.map(original => {
    const name = original.name;
    const regulator = function (...args) {
      const id = count++;
      try {
        trace.push({id, name, args});
        const output = original(...args);
        if (!(output instanceof Promise)) {
          trace.push({id, name, type: 'sync', output});
          return output;
        }
        const asyncStatus = {id, name, type: 'async', pending: output};
        trace.push(asyncStatus);
        output.then(output => trace.push({id, name, type: 'async', output}));
        output.catch(error => trace.push({id, name, type: 'async', error}));
        output.finally(() => delete asyncStatus.pending); //att! mutation.
        return output;
      } catch (error) {
        trace.push({id, type: 'sync', name, error});
        throw error;
      }
    };
    Object.defineProperty(regulator, 'name', {value: '_sm_' + name});
    return regulator;
  });

  //return the trace. If an object is passed in, then any argument or output value matching a property will be renamed.
  function inspectState(obj = {}) {
    const reverseLookup = new Map(Object.entries(obj).map(([one, two]) => [two, one]));
    return trace.map(({id, name, type, output, error, pending, promise}) => {
      const res = {id, name, type};
      output && (res.output = reverseLookup.get(output) || JSON.stringify(output));
      pending && (res.pending = true);
      error && (res.error = reverseLookup.get(error) || error.toString()); //todo how to log errors
      return res;
    });
  }

  //if recursive == true, then ready returns true only when no tasks remain pending.
  //else, the ready await all pending tasks at the point queried returns
  async function ready(recursive) {
    let pendingTasks = trace.filter(({pending}) => pending);
    await Promise.allSettled(pendingTasks);
    pendingTasks = trace.filter(({pending}) => pending);
    if (!recursive)
      return !pendingTasks.length;
    while (await pendingTasks) {
      pendingTasks = trace.filter(({pending}) => pending);
      if (!pendingTasks.length)
        return true;
    }
  }

  return [inspectState, ready, ...regulators];
}

function sumImpl(a, b) {
  return a + b;
}

const [callSequence, sum, pow, sqrt] = listInvocations(sumImpl, Math.pow, Math.sqrt);

function hypotenuse(a, b) {
  return sqrt(sum(pow(a, 2), pow(b, 2)));
}

console.log(hypotenuse(3, 4)); // 5
console.log(callSequence);    // ["pow", "pow", "sumImpl", "sqrt"]
```

Simple solutions built with this pattern can replace both state management solutions such as Redux and development tools such as unit testing. It is truly powerful stuff.

## References

* 

