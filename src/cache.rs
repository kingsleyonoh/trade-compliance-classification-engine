use std::sync::{Arc, Mutex};

#[derive(Debug, Clone)]
pub struct CachedValue<T = String> {
    value: Arc<Mutex<Option<T>>>,
}

impl<T> Default for CachedValue<T> {
    fn default() -> Self {
        Self {
            value: Arc::new(Mutex::new(None)),
        }
    }
}

impl<T: Clone> CachedValue<T> {
    pub fn get_or_try_init<E>(&self, compute: impl FnOnce() -> Result<T, E>) -> Result<T, E> {
        let mut value = self
            .value
            .lock()
            .expect("cache lock should not be poisoned");
        if let Some(existing) = value.as_ref() {
            return Ok(existing.clone());
        }

        let computed = compute()?;
        *value = Some(computed.clone());
        Ok(computed)
    }
}
