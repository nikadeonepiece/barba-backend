/**
 * Stub de jsdom para los tests.
 *
 * `libs/common/src/index.ts` reexporta `pdf-html.service`, que importa jsdom.
 * Cualquier spec que toque `@app/common` arrastra por transitividad a jsdom y a
 * sus dependencias ESM (`@exodus/bytes` y compañía), que Jest no puede parsear
 * con la config CommonJS de este proyecto: la suite falla al COMPILAR, sin
 * llegar a correr un solo caso.
 *
 * Ningún spec ejercita la generación de PDF/HTML, así que se mapea jsdom a este
 * stub desde `jest.moduleNameMapper`. Si algún día se testea PdfHtmlService de
 * verdad, hay que quitar el mapeo y resolver la transformación de ESM.
 */
class JSDOM {
  constructor() {
    throw new Error(
      'jsdom está stubbeado en tests (ver test/jsdom.stub.js). ' +
        'Si necesitas jsdom real, quita el moduleNameMapper de jest en package.json.',
    );
  }
}

module.exports = { JSDOM };
