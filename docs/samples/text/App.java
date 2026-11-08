public class App {
    public static void main(String[] args) {
        String[] formats = {"json", "yaml", "xml", "csv", "text"};
        for (String format : formats) {
            System.out.println("format = " + format);
        }
    }
}
