declare module "adm-zip" {
  export default class AdmZip {
    constructor(path?: string);
    extractAllTo(targetPath: string, overwrite?: boolean): void;
  }
}
