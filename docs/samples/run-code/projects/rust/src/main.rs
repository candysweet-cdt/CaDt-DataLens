fn main() {
    println!("rust 项目命令已执行");
    println!("cwd: {}", std::env::current_dir().unwrap().display());
}
