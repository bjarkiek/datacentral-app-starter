using DataCentral.AppStarter.Api.Options;
using DataCentral.AppStarter.Api.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();

builder.Services.Configure<DataCentralLaunchOptions>(
    builder.Configuration.GetSection("DataCentral"));

builder.Services.AddScoped<IDataCentralLaunchVerifier, DataCentralLaunchVerifier>();

var allowedOrigins = builder.Configuration
    .GetSection("Cors:AllowedOrigins")
    .Get<string[]>() ?? Array.Empty<string>();

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.WithOrigins(allowedOrigins)
              .AllowAnyHeader()
              .AllowAnyMethod()
              .AllowCredentials();
    });
});

var app = builder.Build();

app.UseCors();
app.MapControllers();

app.Run();
