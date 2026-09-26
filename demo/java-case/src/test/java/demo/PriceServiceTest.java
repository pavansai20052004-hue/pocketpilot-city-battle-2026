package demo;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class PriceServiceTest {
    @Test void regularDiscount() {
        assertEquals(90, new PriceService().finalPrice(100, 10));
    }
    @Test void missingDiscountKeepsOriginalAmount() {
        assertEquals(100, new PriceService().finalPrice(100, null));
    }
}
