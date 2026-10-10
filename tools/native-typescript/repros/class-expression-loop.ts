// Perry 0.5.1520 prints second, second. Fork fix: expr_function.rs must distinguish
// fresh lexical loop bindings from forward-declaration reassignments before inserting
// RefreshClassExprCaptures after Stmt::Let; refreshing a new iteration mutates the old class.
// Workaround: create the class in a function invocation with its own capture owner.
// Node: first, second. Each evaluation must retain its own constructor capture and prototype.
const classes: Record<string, new () => object> = {};
for (const name of ["first", "second"]) {
  const C = class Wrapped {
    constructor() {
      console.log(name);
    }
  };
  classes[name] = C;
}
const First = classes.first;
const Second = classes.second;
new First();
new Second();
