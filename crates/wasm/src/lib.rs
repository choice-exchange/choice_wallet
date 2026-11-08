//! The vault for the browser extension: [`handle`], compiled to WASM.
//!
//! The service worker imports the wasm-bindgen glue statically and calls
//! `handle(JSON.stringify({method, params}))`. The protocol is `choice-wallet-vault`'s; this
//! crate only exposes it. It has no `forbid(unsafe_code)`, because the glue
//! `#[wasm_bindgen]` generates uses `unsafe`; the crate itself contains none.

use wasm_bindgen::prelude::wasm_bindgen;
use zeroize::Zeroize;

/// Handle one vault request (JSON) and return the response (JSON).
///
/// The request can hold a password or an unlock key, so its copy in WASM memory is wiped
/// once handled. The caller's JavaScript string can't be wiped: JS strings are immutable.
#[wasm_bindgen]
pub fn handle(mut request: String) -> String {
    let response = choice_wallet_vault::handle(&request);
    request.zeroize();
    response
}
