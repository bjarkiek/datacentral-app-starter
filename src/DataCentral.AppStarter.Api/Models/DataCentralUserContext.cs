namespace DataCentral.AppStarter.Api.Models;

public sealed class DataCentralUserContext
{
    public bool IsVerified { get; set; }

    public UserContext User { get; set; } = new();
    public TenantContext Tenant { get; set; } = new();

    public List<string> Roles { get; set; } = new();
    public List<string> RoleIds { get; set; } = new();

    public string? IssuedAt { get; set; }

    public sealed class UserContext
    {
        public string Id { get; set; } = "";
        public string UserName { get; set; } = "";
        public string DisplayName { get; set; } = "";
    }

    public sealed class TenantContext
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public string ClientUrl { get; set; } = "";
    }
}
