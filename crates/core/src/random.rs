use crate::Error;

/// Fill `buf` from the operating system's CSPRNG (`crypto.getRandomValues`
/// in the browser).
pub(crate) fn fill(buf: &mut [u8]) -> Result<(), Error> {
    getrandom::fill(buf).map_err(|_| Error::Randomness)
}
