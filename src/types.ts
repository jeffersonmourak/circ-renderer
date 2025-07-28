export type CircA = {
  name: string;
  val: string;
};

export type CircWire = {
  from: string;
  to: string;
};

export type CircLibComp = {
  name: string;
  lib: string;
  loc: string;
  a?: CircA[];
};

export type CircCircuitComp = {
  name: string;
  loc: string;
  a?: CircA[];
};

export type CircComp = CircLibComp | CircCircuitComp;

export type CircCircuit = {
  name: string;
  a: CircA[];
  wire: CircWire[];
  comp: CircComp[];
};

export type CircProject = {
  "#text": string;
  circuit: CircCircuit[];
  main: {
    name: string;
  };
  source: string;
  version: string;
};

export type XMLInfo = {
  version: string;
  encoding: string;
  standalone: string;
};

export type CircFile = {
  "?xml": XMLInfo;
  project: CircProject;
};
