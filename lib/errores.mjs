// errores de negocio: el servicio dice que paso sin saber nada de http, y
// http.mjs lo traduce al codigo que corresponde
export class ErrorDeNegocio extends Error {
  constructor(tipo, mensaje) {
    super(mensaje);
    this.name = 'ErrorDeNegocio';
    this.tipo = tipo;
  }
}

export const noEncontrado = (mensaje) => new ErrorDeNegocio('no-encontrado', mensaje);
export const conflicto = (mensaje) => new ErrorDeNegocio('conflicto', mensaje);
