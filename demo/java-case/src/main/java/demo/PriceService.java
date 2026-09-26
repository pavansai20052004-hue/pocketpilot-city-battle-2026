package demo;

public class PriceService {
    public int finalPrice(int amount, Integer percent) {
        return amount - (amount * percent / 100);
    }
}
