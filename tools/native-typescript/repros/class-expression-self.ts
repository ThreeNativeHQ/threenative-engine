// Node: true. Perry 0.5.1520: ReferenceError factory is not defined (in a function-local class).
function create() {
  const factory = class {
    constructor() {
      console.log(factory.prototype !== undefined);
    }
  };
  return factory;
}
const Factory = create();
new Factory();
