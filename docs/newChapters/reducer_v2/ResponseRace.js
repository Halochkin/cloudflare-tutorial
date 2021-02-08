//returns either two Promises or either only success(not a Promise) or error (not a Promise)
function runFun(fun, args) {
  try {
    const res = fun(...args);
    if (!(res instanceof Promise))
      return {success: res};
    let successResolver, errorResolver;
    const success = new Promise(r => successResolver = r), error = new Promise(r => errorResolver = r);
    res.then(v => successResolver(v), e => errorResolver(e));
    return {success, error};
  } catch (err) {
    return {error: err};
  }
}

function firstReadyAction(frame) {
  main: for (let action of frame.actions) {
    const [id, params, fun, output] = action;
    if (frame.sequence.indexOf(`:${id}_`) >= 0) continue;          //action already invoked, this can be done at the start

    if (output in frame.variables) {               //goal completed, cancelling action
      frame.sequence += `:${id}_c`;            // todo this and _waiting can be discovered from analysis of the actions and callSequence..
      continue;
    }
    const args = [];
    for (let pp of params) {
      if (!(pp instanceof Object)) {
        args.push(pp);
      } else if (pp.op === '&&') {
        if (pp.key in frame.variables) {
          frame.sequence += `:${id}_c`;         //todo
          continue main;                        //the && inverse required parameter has already been set, so this action can be cancelled
        }
      } else if (pp.op === '&') {
        if (!(pp.key in frame.variables)) {
          // frame.sequence += `:${id}_w`; // todo illustrates when a function could have been called, but whose arguments was not ready.
          continue main;
        }         //we continue, but we don't add the parameter to the args list
      } else if (pp.op !== '*' && !(pp.key in frame.variables)) {
        // frame.sequence += `:${id}_w`; // todo illustrates when a function could have been called, but whose arguments was not ready.
        continue main;
      } else {
        args.push(frame.variables[pp.key]);
      }
    }
    return {action, args};                                    //else, action is ready
  }
  return {};
}

function asyncActionReturns(frame, callTxt, key, val) {
  if (key in frame.variables)
    return frame.sequence += callTxt + 'b';
  setValue(frame, callTxt, key, val);
  run(frame);
}

function setValue(frame, callTxt, key, val) {
  frame.sequence += callTxt;
  frame.variables[key] = val;
}

function run(frame) {
  for (let {action, args} = firstReadyAction(frame); action; {action, args} = firstReadyAction(frame)) {
    const [id, params, fun, output, error] = action;
    frame.sequence += `:${id}_i`; //adding invoked. This is just a temporary placeholder, in case the runFun crashes.. so we get a debug out.
    frame.preInvoke?.call(frame);
    const result = runFun(fun, args);
    if (result.success instanceof Promise) {
      frame.sequence += 'a';
      result.success.then(val => asyncActionReturns(frame, `:${id}_o`, output, val));
      result.error.then(val => asyncActionReturns(frame, `:${id}_e`, error, val));
    } else if ('success' in result) {
      setValue(frame, 'o', output, result.success);
    } else /*if ('error' in result)*/ {
      setValue(frame, 'e', error, result.error);
    }
  }
  frame.postFrame?.call(frame);
}

function findUnresolvedObserver({actions, variables}) {
  return actions.find(([id, p, f, output, error]) => output.startsWith('_observer_') && !(output in variables) && !(error in variables));
}

function findActionThatCanOutputResponse(actions) {
  return actions.find(([i, p, f, o, e]) => o === 'response' || e === 'response');
}

//be careful not to mutate actions here..
function frameToString({actions, variables: context, sequence}) {
  //todo here i need to unpack the params again. I do that by Json.stringify with a custom clause for the type value entities.. This means i need a class for it.
  actions = actions.map(([id, params, fun, output, error]) => [params.map(p => p instanceof Object ? p.op + p.key : typeof (p) === 'string' ? JSON.stringify(p) : p), fun.name, output, error]);
  const variables = {};
  for (let key in context)
    variables[key] = context[key] === undefined ? null : context[key];
  return btoa(JSON.stringify({actions, sequence, variables}));
}

export function startStack(actions, variables, debug) {
  debug && (debug = (debug instanceof Function ? debug : console.log)); //normalize debug
  const frame = {
    actions, variables, sequence: '', preInvoke: function () {
      debug(frameToString(frame));
    }
  };
  run(frame);
  let response = frame.variables.response, checkResponse;
  if (!('response' in frame.variables) && findActionThatCanOutputResponse(actions)) {
    let resolverResponse;
    response = new Promise(r => resolverResponse = r);
    checkResponse = () => ('response' in frame && (checkResponse = undefined), resolverResponse(frame.response));
  }
  let observer, checkObservers;  //todo here we could return the list of all observers output, like allSettled would do..
  if (findUnresolvedObserver(frame)) {    //todo we would do this by making findUnresolvedObservers into observerStatus
    let resolverObservers;
    observer = new Promise(r => resolverObservers = r);
    checkObservers = () => (!findUnresolvedObserver(frame) && (checkObservers = undefined), resolverObservers(true));
  }
  frame.postFrame = function () {
    debug(frameToString(frame));
    checkResponse?.call();
    checkObservers?.call();
  }
  return {response, observer};
}


// todo
// 1. syntax check for dead end states. We do this by checking each action. If the action is missing a required state (ie. a required state is neither an output of any other action, or a start variable), then we remove this action. We repeat this function recursively until there are no such actions removed in an entire pass). This will remove any loose ends. This can be done at compile time.
//2. if this removes response, or any observers, then this will of course clear the way for any errors.

export function rrListener(actions, e, debug) {
  //todo here we can add the compiler for the '!' operator..
  const {response, observer} = startStack(actions, {request: e.request}, debug);
  observer && e.waitUntil(observer);
  if (response === undefined)
    return;
  if (response instanceof Error)
    throw response;
  if (!(response instanceof Promise))
    return e.respondWith(response);
  e.respondWith(async function () {
    const result = await response;
    if (result === undefined) {
      e.passThroughOnException();      //pass through to subsystem CDN
      throw new Error('passing the request to the CDN subsystem.');
    }
    if (result instanceof Error)
      throw result;
    return result;
  }());
}

/**
 * BUILTIN FUNCTIONS
 */
// doNothing:  a=>a
// fail:       a=>throw a
export function get(obj, path) {
  if (path === '')
    return obj;
  if (!(obj instanceof Object))
    throw new SyntaxError('The action "get" is given an illegal object: ' + typeof obj);
  if (typeof path !== 'string')
    throw new SyntaxError('The action "get" is given an illegal path: ' + typeof path);
  for (let segment of path.split('.')) {
    if (obj instanceof Headers || obj instanceof URLSearchParams)
      obj = obj[segment] || obj.get(segment);
    else
      obj = obj[segment];
  }
  return obj;
}