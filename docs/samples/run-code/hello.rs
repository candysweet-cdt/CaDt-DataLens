fn main() {
    println!("hello from Rust");
    println!("args: {}", std::env::args().count() - 1);
}
