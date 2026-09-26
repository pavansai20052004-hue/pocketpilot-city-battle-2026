using Xunit;
namespace PocketPilotDemo;
public class PriceServiceTests
{
    [Fact]
    public void RegularDiscount() => Assert.Equal(90, new PriceService().FinalPrice(100, 10));

    [Fact]
    public void MissingDiscountKeepsOriginalAmount() => Assert.Equal(100, new PriceService().FinalPrice(100, null));
}
