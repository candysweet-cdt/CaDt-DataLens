//! 一个简单的 Rust 示例
pub struct Lens {
    pub name: String,
    pub count: u32,
}

impl Lens {
    pub fn new(name: &str) -> Self {
        Lens { name: name.to_string(), count: 0 }
    }

    pub fn bump(&mut self) {
        self.count += 1;
    }
}
