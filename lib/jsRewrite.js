// JS AST rewriter for the proxy.
//
// Parses JS source with acorn, walks the AST, and rewrites reads/writes of
// `location`, `parent`, `top` to go through globals `$proxyGet$` /
// `$proxySet$` / `$proxyCall$m` that return the emulated location/parent/top
// objects.
//
// Why: `window.location` is `[Unforgeable]` (HTML spec) — you can't redefine
// it with `Object.defineProperty`. The only way to make `location.origin`
// return the TARGET origin inside page code is to AST-rewrite every
// `location` reference. This is what production proxies (Ultraviolet,
// Corrosion) do.

const acorn = require('acorn');
const astring = require('astring');

// Properties that we intercept reads/writes of.
const REWRITE = new Set(['location', 'parent', 'top']);

// Identifier names that are window-like (so `X.location` means the global).
const WINDOW_LIKE = new Set(['window', 'document', 'self', 'globalThis', 'top', 'parent']);

function rewriteJs(source, opts = {}) {
  if (!source || typeof source !== 'string') return source;

  let ast;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
    });
  } catch (e) {
    return source;
  }

  // First pass: collect scopes where `location`/`parent`/`top` are shadowed
  // (declared as a function param, var, let, const, or class). We use a
  // WeakMap from node to a Set of shadowed names in that node's scope.
  const shadowed = new WeakMap(); // function/block/program node -> Set of shadowed names
  // Program is a top-level scope.
  shadowed.set(ast, new Set());
  collectShadows(ast, null, shadowed, new WeakSet());

  // Walk the AST. We need parent context, so we pass it down.
  try {
    walk(ast, null, new WeakSet(), shadowed, []);
  } catch (e) {
    return source;
  }

  try {
    return astring.generate(ast, { indent: '', lineEnd: '' });
  } catch (e) {
    return source;
  }
}

// Collect shadowed `location`/`parent`/`top` names per scope. We track
// which function/block scopes have local declarations of these names so
// we can skip rewriting Identifier references inside them.
function collectShadows(node, parent, shadowed, seen) {
  if (!node || typeof node !== 'object' || !node.type) return;
  if (seen.has(node)) return;
  seen.add(node);

  // Function-like nodes create a new scope. Their params are in that scope.
  const isFunction = node.type === 'FunctionDeclaration'
    || node.type === 'FunctionExpression'
    || node.type === 'ArrowFunctionExpression'
    || node.type === 'MethodDefinition';
  if (isFunction) {
    const set = new Set();
    shadowed.set(node, set);
    // Collect param names.
    if (node.params) {
      for (const p of node.params) collectPatternNames(p, set);
    }
    if (node.id && node.id.type === 'Identifier') {
      // Function name is in the enclosing scope, not here. Skip.
    }
  }

  // Variable declarations inside this scope (let/const/var) also shadow.
  if (node.type === 'VariableDeclarator' && node.id) {
    // Find the enclosing scope (function or program).
    let scope = parent;
    while (scope && !shadowed.has(scope)) {
      scope = scope.__parent || null;
    }
    if (scope) {
      const set = shadowed.get(scope);
      collectPatternNames(node.id, set);
    }
  }

  // Recurse.
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === '__parent') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === 'object' && child.type) {
          child.__parent = node;
          collectShadows(child, node, shadowed, seen);
        }
      }
    } else if (val && typeof val === 'object' && val.type) {
      val.__parent = node;
      collectShadows(val, node, shadowed, seen);
    }
  }
}

// Collect names from a destructuring pattern (or simple Identifier).
function collectPatternNames(pattern, set) {
  if (!pattern || typeof pattern !== 'object') return;
  if (pattern.type === 'Identifier') {
    if (REWRITE.has(pattern.name)) set.add(pattern.name);
  } else if (pattern.type === 'AssignmentPattern') {
    collectPatternNames(pattern.left, set);
  } else if (pattern.type === 'ArrayPattern') {
    for (const el of pattern.elements) collectPatternNames(el, set);
  } else if (pattern.type === 'ObjectPattern') {
    for (const prop of pattern.properties) {
      if (prop.type === 'Property') collectPatternNames(prop.value, set);
      else if (prop.type === 'RestElement') collectPatternNames(prop.argument, set);
    }
  } else if (pattern.type === 'RestElement') {
    collectPatternNames(pattern.argument, set);
  }
}

// Walk the tree. We use a Set to mark nodes we've already rewritten so we
// don't recurse into our own injected CallExpression. `scopeStack` is the
// chain of enclosing function/block scopes that have shadowed names.
function walk(node, parent, seen, shadowed, scopeStack) {
  if (!node || typeof node !== 'object' || !node.type) return;
  if (seen.has(node)) return;
  seen.add(node);

  // Push this scope onto the stack if it has shadows.
  let pushed = false;
  if (shadowed.has(node)) {
    scopeStack = scopeStack.concat([shadowed.get(node)]);
    pushed = true;
  }

  // Apply the rewriter for this node.
  const mutated = rewriteNode(node, parent, seen, scopeStack);
  if (mutated) {
    if (pushed) {} // popped below
    return;
  }

  // Recurse into children.
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === '__parent') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === 'object' && child.type) {
          child.__parent = node;
          walk(child, node, seen, shadowed, scopeStack);
        }
      }
    } else if (val && typeof val === 'object' && val.type) {
      val.__parent = node;
      walk(val, node, seen, shadowed, scopeStack);
    }
  }
}

// Check if `name` is shadowed in any of the scopes on the stack.
function isShadowed(name, scopeStack) {
  for (const set of scopeStack) {
    if (set.has(name)) return true;
  }
  return false;
}

function rewriteNode(node, parent, seen, scopeStack) {
  // MemberExpression: obj.prop or obj[prop]
  if (node.type === 'MemberExpression') {
    const prop = node.property;
    let propName = null;
    if (!node.computed && prop.type === 'Identifier') {
      propName = prop.name;
    } else if (prop.type === 'Literal') {
      propName = String(prop.value);
    }
    if (!propName || !REWRITE.has(propName)) return false;

    if (parent) {
      if (parent.type === 'UnaryExpression' && parent.operator === 'delete') return false;
      if (parent.type === 'NewExpression' && parent.callee === node) return false;
    }

    // Only rewrite if obj is window-like.
    if (!node.object || node.object.type !== 'Identifier' || !WINDOW_LIKE.has(node.object.name)) {
      return false;
    }

    const propArg = node.computed
      ? node.property
      : { type: 'Literal', value: prop.name };
    const objArg = node.object;

    if (parent && parent.type === 'AssignmentExpression' && parent.left === node) {
      const valueArg = parent.right;
      const opArg = { type: 'Literal', value: parent.operator };
      const call = makeCall('$proxySet$', [objArg, propArg, valueArg, opArg]);
      seen.add(call);
      Object.keys(parent).forEach(k => delete parent[k]);
      Object.assign(parent, call);
      seen.add(parent);
      return true;
    }
    if (parent && parent.type === 'UpdateExpression' && parent.argument === node) {
      const opArg = { type: 'Literal', value: parent.operator };
      const nullArg = { type: 'Literal', value: null };
      const call = makeCall('$proxySet$', [objArg, propArg, nullArg, opArg]);
      seen.add(call);
      Object.keys(parent).forEach(k => delete parent[k]);
      Object.assign(parent, call);
      seen.add(parent);
      return true;
    }
    // Read: replace this MemberExpression with a CallExpression.
    const call = makeCall('$proxyGet$', [objArg, propArg]);
    seen.add(call);
    Object.keys(node).forEach(k => delete node[k]);
    Object.assign(node, call);
    seen.add(node);
    return false; // recurse into the new call's children — but they're marked seen, so walk is a no-op
  }

  // Identifier: bare `location`.
  if (node.type === 'Identifier') {
    if (!REWRITE.has(node.name)) return false;
    // Skip if shadowed in an enclosing scope.
    if (scopeStack && isShadowed(node.name, scopeStack)) return false;
    if (parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return false;
    if (parent) {
      if (parent.type === 'VariableDeclarator' && parent.id === node) return false;
      if (parent.type === 'Property' && parent.key === node && !parent.computed) return false;
      if (parent.type === 'MethodDefinition' && parent.key === node) return false;
      if (parent.type === 'ClassDeclaration' && parent.id === node) return false;
      if (parent.type === 'RestElement' && parent.argument === node) return false;
      if (parent.type === 'ExportSpecifier' && parent.local === node) return false;
      if (parent.type === 'ImportSpecifier' && parent.imported === node) return false;
      if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' || parent.type === 'ArrowFunctionExpression') && parent.params && parent.params.includes(node)) return false;
      if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression') && parent.id === node) return false;
      if (parent.type === 'AssignmentPattern' && parent.left === node) return false;
      if (parent.type === 'LabeledStatement' && parent.label === node) return false;
    }

    if (parent && parent.type === 'AssignmentExpression' && parent.left === node) {
      const valueArg = parent.right;
      const opArg = { type: 'Literal', value: parent.operator };
      const call = makeCall('$proxySet$', [
        { type: 'Identifier', name: 'window' },
        { type: 'Literal', value: node.name },
        valueArg,
        opArg,
      ]);
      seen.add(call);
      Object.keys(parent).forEach(k => delete parent[k]);
      Object.assign(parent, call);
      seen.add(parent);
      return true;
    }
    if (parent && parent.type === 'UpdateExpression' && parent.argument === node) {
      const call = makeCall('$proxySet$', [
        { type: 'Identifier', name: 'window' },
        { type: 'Literal', value: node.name },
        { type: 'Literal', value: null },
        { type: 'Literal', value: parent.operator },
      ]);
      seen.add(call);
      Object.keys(parent).forEach(k => delete parent[k]);
      Object.assign(parent, call);
      seen.add(parent);
      return true;
    }
    // Default: bare `location` read.
    const call = makeCall('$proxyGet$', [
      { type: 'Identifier', name: 'window' },
      { type: 'Literal', value: node.name },
    ]);
    seen.add(call);
    Object.keys(node).forEach(k => delete node[k]);
    Object.assign(node, call);
    seen.add(node);
    return false;
  }

  return false;
}

function makeCall(callee, args) {
  return {
    type: 'CallExpression',
    callee: { type: 'Identifier', name: callee },
    arguments: args,
    optional: false,
  };
}

module.exports = { rewriteJs };
