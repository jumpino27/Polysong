use polysong_core::{IngestCandidate, IngestRequest, Result};

pub trait IngestSource: Send + Sync {
    fn name(&self) -> &'static str;
    fn can_handle(&self, input: &str) -> bool;
    fn prepare(&self, request: &IngestRequest) -> Result<IngestCandidate>;
}

#[derive(Default)]
pub struct IngestRegistry {
    sources: Vec<Box<dyn IngestSource>>,
}

impl IngestRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_source(mut self, source: impl IngestSource + 'static) -> Self {
        self.sources.push(Box::new(source));
        self
    }

    pub fn prepare(&self, request: &IngestRequest) -> Result<IngestCandidate> {
        self.sources
            .iter()
            .find(|source| source.can_handle(&request.input))
            .ok_or_else(|| {
                polysong_core::PolysongError::Message("no ingestor matched input".into())
            })?
            .prepare(request)
    }
}
